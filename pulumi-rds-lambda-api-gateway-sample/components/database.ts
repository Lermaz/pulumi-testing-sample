import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export interface DatabaseArgs {
    subnetIds: pulumi.Input<string>[];
    securityGroupId: pulumi.Input<string>;
    instanceClass: string;
    allocatedStorageGb: number;
    multiAz: boolean;
    deletionProtection: boolean;
    dbName: string;
}

/** PostgreSQL on RDS. The master password is generated and owned by RDS in Secrets Manager. */
export class Database extends pulumi.ComponentResource {
    public readonly address: pulumi.Output<string>;
    public readonly port: pulumi.Output<number>;
    public readonly dbName: string;
    public readonly secretArn: pulumi.Output<string>;

    constructor(name: string, args: DatabaseArgs, opts?: pulumi.ComponentResourceOptions) {
        super("app:components:Database", name, {}, opts);
        const child = { parent: this };

        const subnetGroup = new aws.rds.SubnetGroup(`${name}-subnets`, {
            subnetIds: args.subnetIds,
        }, child);

        const instance = new aws.rds.Instance(`${name}-pg`, {
            engine: "postgres",
            engineVersion: "16",
            instanceClass: args.instanceClass,
            allocatedStorage: args.allocatedStorageGb,
            maxAllocatedStorage: args.allocatedStorageGb * 5, // storage autoscaling
            storageType: "gp3",
            storageEncrypted: true,
            dbName: args.dbName,
            username: "appadmin",
            manageMasterUserPassword: true, // no password in config or Pulumi state
            dbSubnetGroupName: subnetGroup.name,
            vpcSecurityGroupIds: [args.securityGroupId],
            publiclyAccessible: false,
            multiAz: args.multiAz,
            backupRetentionPeriod: 7,
            autoMinorVersionUpgrade: true,
            copyTagsToSnapshot: true,
            deletionProtection: args.deletionProtection,
            skipFinalSnapshot: !args.deletionProtection,
            finalSnapshotIdentifier: args.deletionProtection ? `${name}-final` : undefined,
        }, child);

        this.address = instance.address;
        this.port = instance.port;
        this.dbName = args.dbName;
        this.secretArn = instance.masterUserSecrets.apply(s => s[0].secretArn);
        this.registerOutputs({ address: this.address, secretArn: this.secretArn });
    }
}
