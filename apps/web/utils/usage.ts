import { OpenAIStream } from "ai";
import { TiktokenModel, encodingForModel } from "js-tiktoken";
import { ChatCompletionChunk } from "openai/resources/index";
import { Stream } from "openai/streaming";
import { saveUsage } from "@/utils/redis/usage";
import { publishAiCall } from "@inboxzero/tinybird-ai-analytics";

export async function saveAiUsage({
  email,
  model,
  usage,
  label,
}: {
  email: string;
  model: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  label: string;
}) {
  const cost = calcuateCost(model, usage);

  return Promise.all([
    publishAiCall({
      userId: email,
      provider: "openai",
      totalTokens: usage.total_tokens,
      completionTokens: usage.completion_tokens,
      promptTokens: usage.prompt_tokens,
      cost,
      model,
      timestamp: Date.now(),
      label,
    }),
    saveUsage({ email, cost, usage }),
  ]);
}

export async function saveAiUsageStream({
  response,
  model,
  userEmail,
  messages,
  label,
  onFinal,
}: {
  response: Stream<ChatCompletionChunk>;
  model: string;
  userEmail: string;
  messages: { role: "system" | "user"; content: string }[];
  label: string;
  onFinal?: (completion: string) => Promise<void>;
}) {
  const enc = encodingForModel(model as TiktokenModel);
  let completionTokens = 0;

  // to count token usage:
  // https://www.linkedin.com/pulse/token-usage-openai-streams-peter-marton-7bgpc/
  const stream = OpenAIStream(response, {
    onToken: (content) => {
      // We call encode for every message as some experienced
      // regression when tiktoken called with the full completion
      const tokenList = enc.encode(content);
      completionTokens += tokenList.length;
    },
    async onFinal(completion) {
      const promptTokens = messages.reduce(
        (total, msg) => total + enc.encode(msg.content ?? "").length,
        0,
      );

      await Promise.all([
        onFinal?.(completion),
        saveAiUsage({
          email: userEmail,
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
          model,
          label,
        }),
      ]);
    },
  });

  return stream;
}

// https://openai.com/pricing
const costs: Record<
  string,
  {
    input: number;
    output: number;
  }
> = {
  "gpt-3.5-turbo-1106": {
    input: 0.001 / 1000,
    output: 0.002 / 1000,
  },
  "gpt-4-turbo-preview": {
    input: 0.01 / 1000,
    output: 0.03 / 1000,
  },
};

// returns cost in cents
function calcuateCost(
  model: string,
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
  },
): number {
  if (!costs[model]) return 0;

  const { input, output } = costs[model];

  return usage.prompt_tokens * input + usage.completion_tokens * output;
}
