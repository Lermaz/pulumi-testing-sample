import * as pulumi from "@pulumi/pulumi";
import { Network } from "./components/network";
import { Database } from "./components/database";
import { ProductsApi } from "./components/products-api";

const config = new pulumi.Config();
const dbInstanceClass = config.get("dbInstanceClass") ?? "db.t4g.micro";
const dbAllocatedStorageGb = config.getNumber("dbAllocatedStorageGb") ?? 20;
const dbMultiAz = config.getBoolean("dbMultiAz") ?? false;
// Safe by default: prod keeps protection + final snapshot; dev stack turns it off.
const deletionProtection = config.getBoolean("deletionProtection") ?? true;
const logRetentionDays = config.getNumber("logRetentionDays") ?? 14;

const network = new Network("net");

const database = new Database("db", {
    subnetIds: network.privateSubnetIds,
    securityGroupId: network.dbSecurityGroupId,
    instanceClass: dbInstanceClass,
    allocatedStorageGb: dbAllocatedStorageGb,
    multiAz: dbMultiAz,
    deletionProtection,
    dbName: "products",
});

const api = new ProductsApi("products", {
    subnetIds: network.privateSubnetIds,
    lambdaSecurityGroupId: network.lambdaSecurityGroupId,
    dbHost: database.address,
    dbPort: database.port,
    dbName: database.dbName,
    dbSecretArn: database.secretArn,
    logRetentionDays,
});

export const apiUrl = api.url;
export const dbEndpoint = database.address;
export const dbSecretArn = database.secretArn;
