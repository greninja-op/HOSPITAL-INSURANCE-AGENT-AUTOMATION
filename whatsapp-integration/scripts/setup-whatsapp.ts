/**
 * One-off Meta-side setup: WhatsApp conversational automation (ice-breakers + commands).
 *
 * Run once after the number is provisioned:  `tsx scripts/setup-whatsapp.ts`
 * Pass `--show` to print the current configuration instead of writing.
 *
 * This configures the tap-to-start prompts a patient sees, plus slash-commands for
 * staff. It is NOT part of the runtime request path.
 */
const API_VERSION = process.env.WHATSAPP_API_VERSION ?? "v23.0";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_TOKEN;

const ICE_BREAKERS = [
  "Check my authorization status",
  "My insurance denied a procedure",
  "Upload a denial letter",
  "Talk to my care team",
];

const COMMANDS = [
  { command_name: "status", command_description: "Get an update on your case" },
  { command_name: "help", command_description: "See what I can do" },
];

async function main() {
  if (!PHONE_NUMBER_ID || !TOKEN) {
    throw new Error("Set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_TOKEN before running.");
  }
  const base = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}`;
  const show = process.argv.includes("--show");

  if (show) {
    const res = await fetch(`${base}?fields=conversational_automation`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    console.log(JSON.stringify(await res.json(), null, 2));
    return;
  }

  const res = await fetch(`${base}/conversational_automation`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      enable_welcome_message: true,
      prompts: ICE_BREAKERS.map((prompt) => ({ prompt })),
      commands: COMMANDS,
    }),
  });
  console.log(res.ok ? "conversational automation updated" : "update failed");
  console.log(JSON.stringify(await res.json(), null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
