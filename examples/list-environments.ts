import { CodexCloudClient } from "../src/index.js";

const client = await CodexCloudClient.fromCodexHome();
const environments = await client.environments.list();

for (const environment of environments) {
  console.log(`${environment.label}\t${environment.id}`);
}
