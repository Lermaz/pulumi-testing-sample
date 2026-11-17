import * as path from "path";
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { bundleLambda } from "../lib/bundle";

export interface ProductsApiArgs {
    subnetIds: pulumi.Input<string>[];
    lambdaSecurityGroupId: pulumi.Input<string>;
    dbHost: pulumi.Input<string>;
    dbPort: pulumi.Input<number>;
    dbName: string;
    dbSecretArn: pulumi.Input<string>;
    logRetentionDays: number;
}

const ROUTES = [
    { key: "create", method: "POST",   path: "/products" },
    { key: "list",   method: "GET",    path: "/products" },
    { key: "get",    method: "GET",    path: "/products/{id}" },
    { key: "update", method: "PUT",    path: "/products/{id}" },
    { key: "remove", method: "DELETE", path: "/products/{id}" },
] as const;

/** HTTP API + one Lambda per CRUD operation (all sharing one bundle). */
export class ProductsApi extends pulumi.ComponentResource {
    public readonly url: pulumi.Output<string>;

    constructor(name: string, args: ProductsApiArgs, opts?: pulumi.ComponentResourceOptions) {
        super("app:components:ProductsApi", name, {}, opts);
        const child = { parent: this };

        const role = new aws.iam.Role(`${name}-role`, {
            assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "lambda.amazonaws.com" }),
        }, child);

        const vpcAccess = new aws.iam.RolePolicyAttachment(`${name}-vpc-access`, {
            role: role.name,
            policyArn: aws.iam.ManagedPolicy.AWSLambdaVPCAccessExecutionRole, // logs + ENIs
        }, child);

        new aws.iam.RolePolicy(`${name}-read-db-secret`, {
            role: role.id,
            policy: aws.iam.getPolicyDocumentOutput({
                statements: [{
                    effect: "Allow",
                    actions: ["secretsmanager:GetSecretValue"],
                    resources: [args.dbSecretArn], // only the DB secret, nothing else
                }],
            }, child).json,
        }, child);

        const codeDir = bundleLambda(path.join(__dirname, "..", "lambdas", "products"));
        const code = new pulumi.asset.FileArchive(codeDir);

        const api = new aws.apigatewayv2.Api(`${name}-api`, { protocolType: "HTTP" }, child);

        for (const r of ROUTES) {
            const logGroup = new aws.cloudwatch.LogGroup(`${name}-${r.key}-logs`, {
                name: `/aws/lambda/${name}-${r.key}`,
                retentionInDays: args.logRetentionDays,
            }, child);

            const fn = new aws.lambda.Function(`${name}-${r.key}`, {
                role: role.arn,
                runtime: aws.lambda.Runtime.NodeJS22dX,
                architectures: ["arm64"],
                handler: `index.${r.key}`,
                code,
                memorySize: 256,
                timeout: 10,
                vpcConfig: {
                    subnetIds: args.subnetIds,
                    securityGroupIds: [args.lambdaSecurityGroupId],
                },
                environment: {
                    variables: {
                        DB_HOST: args.dbHost,
                        DB_PORT: pulumi.output(args.dbPort).apply(String),
                        DB_NAME: args.dbName,
                        DB_SECRET_ARN: args.dbSecretArn,
                    },
                },
                loggingConfig: { logFormat: "JSON", logGroup: logGroup.name },
            }, { ...child, dependsOn: [vpcAccess] });

            const integration = new aws.apigatewayv2.Integration(`${name}-${r.key}-int`, {
                apiId: api.id,
                integrationType: "AWS_PROXY",
                integrationMethod: "POST",
                integrationUri: fn.invokeArn,
                payloadFormatVersion: "2.0",
            }, child);

            new aws.apigatewayv2.Route(`${name}-${r.key}-route`, {
                apiId: api.id,
                routeKey: `${r.method} ${r.path}`,
                target: pulumi.interpolate`integrations/${integration.id}`,
            }, child);

            new aws.lambda.Permission(`${name}-${r.key}-invoke`, {
                action: "lambda:InvokeFunction",
                function: fn.name,
                principal: "apigateway.amazonaws.com",
                sourceArn: pulumi.interpolate`${api.executionArn}/*/${r.method}${r.path.replace(/\{[^}]+\}/g, "*")}`,
            }, child);
        }

        const accessLogs = new aws.cloudwatch.LogGroup(`${name}-access-logs`, {
            name: `/aws/apigateway/${name}`,
            retentionInDays: args.logRetentionDays,
        }, child);

        new aws.apigatewayv2.Stage(`${name}-stage`, {
            apiId: api.id,
            name: "$default",
            autoDeploy: true,
            defaultRouteSettings: { throttlingBurstLimit: 50, throttlingRateLimit: 100 },
            accessLogSettings: {
                destinationArn: accessLogs.arn,
                format: JSON.stringify({
                    requestId: "$context.requestId",
                    ip: "$context.identity.sourceIp",
                    routeKey: "$context.routeKey",
                    status: "$context.status",
                    latencyMs: "$context.responseLatency",
                    integrationError: "$context.integrationErrorMessage",
                }),
            },
        }, child);

        this.url = api.apiEndpoint;
        this.registerOutputs({ url: this.url });
    }
}
