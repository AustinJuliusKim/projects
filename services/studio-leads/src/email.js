import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function buildWelcome({ lead, checklistUrl, mailingAddress, from }) {
  const note = `Not interested? Just reply to this email and we will remove you.`;
  const text = [
    `Hi ${lead.firstName},`,
    "",
    "Thanks for your interest. Here is your small business tech checklist:",
    checklistUrl,
    "",
    note,
    mailingAddress,
  ].join("\n");
  const html = `<p>Hi ${esc(lead.firstName)},</p>
<p>Thanks for your interest. Here is your <a href="${esc(checklistUrl)}">small business tech checklist</a>.</p>
<p style="font-size:12px;color:#666">${esc(note)}<br>${esc(mailingAddress)}</p>`;
  return { from, text, html };
}

export function createWelcomeSender({ client = new SESv2Client({}), env = process.env } = {}) {
  return async function sendWelcome(lead) {
    const from = env.FROM_ADDRESS;
    const { text, html } = buildWelcome({
      lead,
      checklistUrl: env.CHECKLIST_URL ?? "",
      mailingAddress: env.MAILING_ADDRESS ?? "",
      from,
    });
    await client.send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [lead.email] },
        ReplyToAddresses: [from],
        Content: {
          Simple: {
            Subject: { Data: "Your small business tech checklist", Charset: "UTF-8" },
            Body: { Text: { Data: text, Charset: "UTF-8" }, Html: { Data: html, Charset: "UTF-8" } },
          },
        },
      }),
    );
  };
}
