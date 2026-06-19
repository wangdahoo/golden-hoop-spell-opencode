import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

const plugin: Plugin = async (ctx) => {
  return {
    tool: {
      "ghs-spike-test": tool({
        description:
          "Spike 001 verification tool. Round-trips a JSON arg/result. Returns a greeting string with the supplied echo value.",
        args: {
          echo: tool.schema.string().describe("String to echo back in the result"),
        },
        async execute(args) {
          return JSON.stringify({
            ok: true,
            received: args.echo,
            echoed_at: new Date().toISOString(),
          });
        },
      }),
    },
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push("SPIKE MARKER 001 — ghs-spike-test tool is registered");
    },
  };
};

export default plugin;
