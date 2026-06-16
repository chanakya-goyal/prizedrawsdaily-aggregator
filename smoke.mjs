import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";
const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_KEY });
try {
  const { text } = await generateText({ model: google("gemini-2.0-flash"), prompt: "Reply with exactly: OK" });
  console.log("SDK SUCCESS:", JSON.stringify(text.trim()));
} catch (e) {
  console.log("SDK ERR:", e.name, "|", e.message);
  console.log("status:", e.statusCode ?? e.status ?? "?");
  const body = e.responseBody ?? (e.data && JSON.stringify(e.data)) ?? "";
  console.log("body:", String(body).slice(0,500));
}
