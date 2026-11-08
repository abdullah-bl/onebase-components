// Email package entry point.

export type { EmailMessage, SendResult, Transport, TransportOptions } from "./types";
export { createResend } from "./transports/resend";
export { createPostmark } from "./transports/postmark";
export { createSmtp, type SmtpOptions } from "./transports/smtp";
export { createSendCode, DEFAULT_TEMPLATES, render, type CodeTemplate, type SendCodeFn, type SendCodeMessage } from "./send-code";
