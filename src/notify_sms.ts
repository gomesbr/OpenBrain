import { config } from "./config.js";

function normalizePhone(input: string): string {
  const digits = String(input ?? "").replace(/\D+/g, "");
  if (!digits) return "";
  if (digits.startsWith("1") && digits.length === 11) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.startsWith("+")) return digits;
  return `+${digits}`;
}

function trimMessage(input: string): string {
  const text = String(input ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= 160) return text;
  return `${text.slice(0, 157)}...`;
}

export function isSmsConfigured(overrideTo?: string): { enabled: boolean; reason?: string; to?: string } {
  if (!config.smsEnabled) {
    return { enabled: false, reason: "OPENBRAIN_SMS_ENABLED is false" };
  }
  const to = normalizePhone(overrideTo ?? config.smsTo);
  if (!to) return { enabled: false, reason: "Missing OPENBRAIN_SMS_TO", to: "" };
  if (config.smsProvider !== "twilio") return { enabled: false, reason: `Unsupported provider: ${config.smsProvider}`, to };
  if (!config.twilioAccountSid) return { enabled: false, reason: "Missing TWILIO_ACCOUNT_SID", to };
  if (!config.twilioAuthToken) return { enabled: false, reason: "Missing TWILIO_AUTH_TOKEN", to };
  const from = normalizePhone(config.twilioFromNumber);
  if (!from) return { enabled: false, reason: "Missing TWILIO_FROM_NUMBER", to };
  return { enabled: true, to };
}

async function sendViaTwilio(params: { to: string; body: string }): Promise<void> {
  const from = normalizePhone(config.twilioFromNumber);
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.twilioAccountSid)}/Messages.json`;
  const form = new URLSearchParams();
  form.set("To", params.to);
  form.set("From", from);
  form.set("Body", trimMessage(params.body));

  const auth = Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`, "utf8").toString("base64");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Twilio send failed (${response.status}): ${body.slice(0, 500)}`);
  }
}

export async function sendSmsNotification(message: string, overrideTo?: string): Promise<{ ok: boolean; reason?: string }> {
  const status = isSmsConfigured(overrideTo);
  if (!status.enabled) {
    return { ok: false, reason: status.reason ?? "SMS not configured" };
  }
  const to = normalizePhone(overrideTo ?? status.to ?? "");
  try {
    if (config.smsProvider === "twilio") {
      await sendViaTwilio({ to, body: message });
      return { ok: true };
    }
    return { ok: false, reason: `Unsupported provider: ${config.smsProvider}` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason };
  }
}

export function formatStrategyMessage(params: {
  group: number;
  strategyId: string;
  variantId: string;
  success: boolean;
}): string {
  const raw = String(params.strategyId ?? "");
  const num = raw.replace(/^S/i, "");
  const v = String(params.variantId ?? "v1").replace(/^.*\./, "").toUpperCase();
  return params.success
    ? `Group ${params.group} S${num} ${v} Succeeded`
    : `Group ${params.group} S${num} ${v} Failed`;
}
