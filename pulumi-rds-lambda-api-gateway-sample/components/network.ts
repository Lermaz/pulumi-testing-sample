import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export interface NetworkArgs {
    /** Number of AZs / private subnets (RDS needs at least 2). */
    azCount?: number;
}

/**
 * Private-only network: no internet gateway, no NAT.
 * Lambdas reach RDS locally and Secrets Manager through a VPC interface endpoint.
 */
export class Network extends pulumi.ComponentResource {
    public readonly vpcId: pulumi.Output<string>;
    public readonly privateSubnetIds: pulumi.Output<string>[];
    public readonly lambdaSecurityGroupId: pulumi.Output<string>;
    public readonly dbSecurityGroupId: pulumi.Output<string>;

    constructor(name: string, args: NetworkArgs = {}, opts?: pulumi.ComponentResourceOptions) {
        super("app:components:Network", name, {}, opts);

        const azCount = args.azCount ?? 2;
        const child = { parent: this };

        const vpc = new aws.ec2.Vpc(`${name}-vpc`, {
            cidrBlock: "10.0.0.0/16",
            enableDnsSupport: true,
            enableDnsHostnames: true, // required for the endpoint's private DNS
            tags: { Name: `${name}-vpc` },
        }, child);

        const azs = aws.getAvailabilityZonesOutput({ state: "available" }, child);

        const subnets = Array.from({ length: azCount }, (_, i) =>
            new aws.ec2.Subnet(`${name}-private-${i}`, {
                vpcId: vpc.id,
                cidrBlock: `10.0.${i}.0/24`,
                availabilityZone: azs.names.apply(n => n[i]),
                mapPublicIpOnLaunch: false,
                tags: { Name: `${name}-private-${i}` },
            }, child));

        const lambdaSg = new aws.ec2.SecurityGroup(`${name}-lambda-sg`, {
            vpcId: vpc.id,
            description: "Product Lambdas",
        }, child);
        const dbSg = new aws.ec2.SecurityGroup(`${name}-db-sg`, {
            vpcId: vpc.id,
            description: "RDS PostgreSQL",
        }, child);
        const endpointSg = new aws.ec2.SecurityGroup(`${name}-endpoint-sg`, {
            vpcId: vpc.id,
            description: "Secrets Manager VPC endpoint",
        }, child);

        // Rules are separate resources (not inline) and reference SGs, never CIDRs.
        new aws.vpc.SecurityGroupIngressRule(`${name}-db-from-lambda`, {
            securityGroupId: dbSg.id,
            referencedSecurityGroupId: lambdaSg.id,
            ipProtocol: "tcp", fromPort: 5432, toPort: 5432,
            description: "PostgreSQL from product Lambdas",
        }, child);
        new aws.vpc.SecurityGroupEgressRule(`${name}-lambda-to-db`, {
            securityGroupId: lambdaSg.id,
            referencedSecurityGroupId: dbSg.id,
            ipProtocol: "tcp", fromPort: 5432, toPort: 5432,
            description: "Lambdas to PostgreSQL",
        }, child);
        new aws.vpc.SecurityGroupIngressRule(`${name}-endpoint-from-lambda`, {
            securityGroupId: endpointSg.id,
            referencedSecurityGroupId: lambdaSg.id,
            ipProtocol: "tcp", fromPort: 443, toPort: 443,
            description: "HTTPS from product Lambdas",
        }, child);
        new aws.vpc.SecurityGroupEgressRule(`${name}-lambda-to-endpoint`, {
            securityGroupId: lambdaSg.id,
            referencedSecurityGroupId: endpointSg.id,
            ipProtocol: "tcp", fromPort: 443, toPort: 443,
            description: "Lambdas to Secrets Manager endpoint",
        }, child);

        const region = aws.getRegionOutput({}, child);
        new aws.ec2.VpcEndpoint(`${name}-secretsmanager`, {
            vpcId: vpc.id,
            serviceName: pulumi.interpolate`com.amazonaws.${region.region}.secretsmanager`,
            vpcEndpointType: "Interface",
            subnetIds: subnets.map(s => s.id),
            securityGroupIds: [endpointSg.id],
            privateDnsEnabled: true,
        }, child);

        this.vpcId = vpc.id;
        this.privateSubnetIds = subnets.map(s => s.id);
        this.lambdaSecurityGroupId = lambdaSg.id;
        this.dbSecurityGroupId = dbSg.id;
        this.registerOutputs({ vpcId: this.vpcId });
    }
}
