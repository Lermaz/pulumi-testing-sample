// import * as pulumi from "@pulumi/pulumi";

// type Recorded = { type: string; name: string; id: string; inputs: Record<string, any> };

// const resources: Recorded[] = [];
// const ofType = (type: string) => resources.filter(r => r.type === type);
// const one = (type: string, nameIncludes?: string) => {
//     const found = ofType(type).filter(r => !nameIncludes || r.name.includes(nameIncludes));
//     if (found.length !== 1) throw new Error(`Expected 1 ${type} (${nameIncludes}), got ${found.length}`);
//     return found[0];
// };
// const valueOf = <T>(o: pulumi.Output<T>) => new Promise<T>(resolve => o.apply(resolve));

// let infra: typeof import("../index");

// /** Resources register asynchronously once their inputs resolve; wait until the count stops growing. */
// async function settle() {
//     let last = -1, stable = 0;
//     while (stable < 6) {
//         await new Promise(r => setTimeout(r, 50));
//         stable = resources.length === last ? stable + 1 : 0;
//         last = resources.length;
//     }
// }

// beforeAll(async () => {
//     await pulumi.runtime.setMocks({
//         newResource: (args) => {
//             const id = `${args.name}-id`;
//             resources.push({ type: args.type, name: args.name, id, inputs: args.inputs });
//             const state: Record<string, any> = { ...args.inputs };
//             switch (args.type) {
//                 case "aws:rds/instance:Instance":
//                     state.address = "mock-db.abc.us-east-1.rds.amazonaws.com";
//                     state.port = 5432;
//                     state.masterUserSecrets = [{ secretArn: "arn:aws:secretsmanager:us-east-1:111122223333:secret:rds!db-mock" }];
//                     break;
//                 case "aws:apigatewayv2/api:Api":
//                     state.apiEndpoint = "https://abc123.execute-api.us-east-1.amazonaws.com";
//                     state.executionArn = "arn:aws:execute-api:us-east-1:111122223333:abc123";
//                     break;
//                 case "aws:lambda/function:Function":
//                     state.invokeArn = `arn:aws:apigateway:us-east-1:lambda:path/functions/${args.name}/invocations`;
//                     break;
//                 case "aws:cloudwatch/logGroup:LogGroup":
//                     state.arn = `arn:aws:logs:us-east-1:111122223333:log-group:${args.name}`;
//                     break;
//                 case "aws:iam/role:Role":
//                     state.arn = `arn:aws:iam::111122223333:role/${args.name}`;
//                     break;
//             }
//             return { id, state };
//         },
//         call: (args) => {
//             switch (args.token) {
//                 case "aws:index/getAvailabilityZones:getAvailabilityZones":
//                     return { names: ["us-east-1a", "us-east-1b", "us-east-1c"] };
//                 case "aws:index/getRegion:getRegion":
//                     return { name: "us-east-1", region: "us-east-1" };
//                 case "aws:iam/getPolicyDocument:getPolicyDocument":
//                     return { json: JSON.stringify({ Version: "2012-10-17", Statement: args.inputs.statements }) };
//             }
//             return args.inputs;
//         },
//     }, "products-crud", "test");

//     infra = await import("../index"); // must be imported AFTER setMocks
//     await valueOf(infra.apiUrl);
//     await settle();
// });

// describe("network (aws.ec2)", () => {
//     it("is private-only: no internet gateway, NAT or public subnets", () => {
//         expect(ofType("aws:ec2/internetGateway:InternetGateway")).toHaveLength(0);
//         expect(ofType("aws:ec2/natGateway:NatGateway")).toHaveLength(0);
//         expect(ofType("aws:ec2/subnet:Subnet").length).toBeGreaterThan(0);
//         for (const s of ofType("aws:ec2/subnet:Subnet")) {
//             expect(s.inputs.mapPublicIpOnLaunch).toBe(false);
//         }
//     });

//     it("spreads subnets over at least two AZs (RDS requirement)", () => {
//         const azs = new Set(ofType("aws:ec2/subnet:Subnet").map(s => s.inputs.availabilityZone));
//         expect(azs.size).toBeGreaterThanOrEqual(2);
//     });

//     it("enables DNS hostnames so the endpoint's private DNS works", () => {
//         const vpc = one("aws:ec2/vpc:Vpc");
//         expect(vpc.inputs.enableDnsSupport).toBe(true);
//         expect(vpc.inputs.enableDnsHostnames).toBe(true);
//     });

//     it("never opens an ingress rule to the internet", () => {
//         expect(ofType("aws:vpc/securityGroupIngressRule:SecurityGroupIngressRule").length).toBeGreaterThan(0);
//         for (const rule of ofType("aws:vpc/securityGroupIngressRule:SecurityGroupIngressRule")) {
//             expect(rule.inputs.cidrIpv4).toBeUndefined();
//             expect(rule.inputs.cidrIpv6).toBeUndefined();
//             expect(rule.inputs.referencedSecurityGroupId).toBeDefined();
//         }
//     });

//     it("lets only the Lambda security group reach PostgreSQL on 5432", () => {
//         const rule = one("aws:vpc/securityGroupIngressRule:SecurityGroupIngressRule", "db-from-lambda");
//         expect(rule.inputs.securityGroupId).toBe(one("aws:ec2/securityGroup:SecurityGroup", "db-sg").id);
//         expect(rule.inputs.referencedSecurityGroupId).toBe(one("aws:ec2/securityGroup:SecurityGroup", "lambda-sg").id);
//         expect([rule.inputs.fromPort, rule.inputs.toPort]).toEqual([5432, 5432]);
//     });

//     it("reaches Secrets Manager through an interface endpoint with private DNS", () => {
//         const ep = one("aws:ec2/vpcEndpoint:VpcEndpoint");
//         expect(ep.inputs.serviceName).toBe("com.amazonaws.us-east-1.secretsmanager");
//         expect(ep.inputs.vpcEndpointType).toBe("Interface");
//         expect(ep.inputs.privateDnsEnabled).toBe(true);
//     });
// });

// describe("database (aws.rds)", () => {
//     it("is encrypted, private and backed up", () => {
//         const db = one("aws:rds/instance:Instance").inputs;
//         expect(db.storageEncrypted).toBe(true);
//         expect(db.publiclyAccessible).toBe(false);
//         expect(db.backupRetentionPeriod).toBeGreaterThanOrEqual(7);
//     });

//     it("lets RDS manage the master password (none in config or state)", () => {
//         const db = one("aws:rds/instance:Instance").inputs;
//         expect(db.manageMasterUserPassword).toBe(true);
//         expect(db.password).toBeUndefined();
//     });

//     it("is protected by default and takes a final snapshot", () => {
//         const db = one("aws:rds/instance:Instance").inputs;
//         expect(db.deletionProtection).toBe(true);
//         expect(db.skipFinalSnapshot).toBe(false);
//         expect(db.finalSnapshotIdentifier).toBeDefined();
//     });

//     it("uses the DB security group and a multi-subnet group", () => {
//         const db = one("aws:rds/instance:Instance").inputs;
//         expect(db.vpcSecurityGroupIds).toEqual([one("aws:ec2/securityGroup:SecurityGroup", "db-sg").id]);
//         expect(one("aws:rds/subnetGroup:SubnetGroup").inputs.subnetIds.length).toBeGreaterThanOrEqual(2);
//     });
// });

// describe("lambdas", () => {
//     const fns = () => ofType("aws:lambda/function:Function");

//     it("creates one function per CRUD operation", () => {
//         expect(fns().map(f => f.inputs.handler).sort())
//             .toEqual(["index.create", "index.get", "index.list", "index.remove", "index.update"]);
//     });

//     it("runs every function inside the VPC with the Lambda security group", () => {
//         const sg = one("aws:ec2/securityGroup:SecurityGroup", "lambda-sg").id;
//         expect(fns()).toHaveLength(5);
//         for (const f of fns()) {
//             expect(f.inputs.vpcConfig.securityGroupIds).toEqual([sg]);
//             expect(f.inputs.vpcConfig.subnetIds.length).toBeGreaterThanOrEqual(2);
//         }
//     });

//     it("sets sane runtime defaults", () => {
//         expect(fns()).toHaveLength(5);
//         for (const f of fns()) {
//             expect(f.inputs.runtime).toBe("nodejs22.x");
//             expect(f.inputs.architectures).toEqual(["arm64"]);
//             expect(f.inputs.timeout).toBeLessThanOrEqual(30);
//         }
//     });

//     it("passes the secret ARN, never a password", () => {
//         expect(fns()).toHaveLength(5);
//         for (const f of fns()) {
//             const vars = f.inputs.environment.variables;
//             expect(vars.DB_SECRET_ARN).toContain("secretsmanager");
//             expect(Object.keys(vars).some(k => /pass(word)?|pwd/i.test(k))).toBe(false);
//         }
//     });

//     it("keeps logs with a finite retention", () => {
//         const groups = ofType("aws:cloudwatch/logGroup:LogGroup");
//         expect(groups.length).toBeGreaterThanOrEqual(5);
//         for (const g of groups) expect(g.inputs.retentionInDays).toBeGreaterThan(0);
//     });

//     it("grants the role access to the DB secret only", () => {
//         const policy = JSON.parse(one("aws:iam/rolePolicy:RolePolicy").inputs.policy);
//         expect(policy.Statement).toHaveLength(1);
//         expect(policy.Statement[0].actions).toEqual(["secretsmanager:GetSecretValue"]);
//         expect(policy.Statement[0].resources).toEqual([expect.stringContaining("secretsmanager")]);
//     });
// });

// describe("api gateway", () => {
//     it("exposes exactly the five product routes", () => {
//         expect(ofType("aws:apigatewayv2/route:Route").map(r => r.inputs.routeKey).sort()).toEqual([
//             "DELETE /products/{id}",
//             "GET /products",
//             "GET /products/{id}",
//             "POST /products",
//             "PUT /products/{id}",
//         ]);
//     });

//     it("lets API Gateway invoke each function, scoped to its own route", () => {
//         const perms = ofType("aws:lambda/permission:Permission");
//         expect(perms).toHaveLength(5);
//         for (const p of perms) {
//             expect(p.inputs.principal).toBe("apigateway.amazonaws.com");
//             expect(p.inputs.sourceArn).not.toMatch(/\/\*\/\*$/); // no blanket /*/*
//         }
//     });

//     it("throttles and writes access logs", () => {
//         const stage = one("aws:apigatewayv2/stage:Stage").inputs;
//         expect(stage.defaultRouteSettings.throttlingRateLimit).toBeGreaterThan(0);
//         expect(stage.accessLogSettings.destinationArn).toBeDefined();
//     });
// });

// describe("stack outputs", () => {
//     it("exports the API URL and DB endpoint", async () => {
//         expect(await valueOf(infra.apiUrl)).toMatch(/^https:\/\/.+execute-api/);
//         expect(await valueOf(infra.dbEndpoint)).toContain("rds.amazonaws.com");
//     });
// });
