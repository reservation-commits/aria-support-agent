import axios from "axios";
import { config } from "./config.js";

export async function transcribeAudio(base64: string, mimetype: string): Promise<string | null> {
  if (!config.openaiKey) {
    console.warn("[media] OPENAI_API_KEY not set — cannot transcribe audio");
    return null;
  }
  try {
    const buffer = Buffer.from(base64, "base64");
    const ext = mimeToExt(mimetype);
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mimetype }), `audio.${ext}`);
    form.append("model", "whisper-1");

    const { data } = await axios.post("https://api.openai.com/v1/audio/transcriptions", form, {
      headers: { Authorization: `Bearer ${config.openaiKey}` },
      timeout: 60_000,
      maxBodyLength: Infinity,
    });
    return typeof data?.text === "string" ? data.text : null;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.error("[media.transcribe]", err.response?.status, err.response?.data);
    } else {
      console.error("[media.transcribe]", err);
    }
    return null;
  }
}

function mimeToExt(mime: string): string {
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mpeg")) return "mp3";
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("webm")) return "webm";
  return "ogg";
}
