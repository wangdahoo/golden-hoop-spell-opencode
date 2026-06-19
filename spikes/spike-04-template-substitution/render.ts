import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const TEMPLATE_PLACEHOLDER = "__GHS_MODEL_TEST__";

async function main() {
  const modelId = process.env.GHS_MODEL_ID;
  if (!modelId) {
    console.error("ERROR: GHS_MODEL_ID env var is required");
    process.exit(1);
  }

  const spikeRoot = resolve(import.meta.dirname, ".");
  const templatePath = resolve(spikeRoot, "ghs-test.md.template");
  const outPath = resolve(spikeRoot, ".opencode/agents/ghs-test.md");

  const template = await readFile(templatePath, "utf8");
  if (!template.includes(TEMPLATE_PLACEHOLDER)) {
    console.error(`ERROR: template does not contain ${TEMPLATE_PLACEHOLDER}`);
    process.exit(1);
  }

  const rendered = template.replaceAll(TEMPLATE_PLACEHOLDER, modelId);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, rendered, "utf8");

  console.log(`rendered ${outPath}`);
  console.log(`substituted ${TEMPLATE_PLACEHOLDER} -> ${modelId}`);
}

main().catch((err) => {
  console.error("render failed:", err);
  process.exit(1);
});
