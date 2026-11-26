import nodemailer from 'nodemailer';
import { isValidEmail } from './security.js';
import type { MonitorItem, Offer, RuntimeConfig } from './types.js';

export interface NotificationResult {
  sent: string[];
  errors: string[];
}

function allowClientOverrides(): boolean {
  return process.env.ALLOW_CLIENT_RUNTIME_CONFIG === 'true';
}

export function formatNotificationMessage(offer: Offer): string {
  const sym = offer.currency === 'USD' ? 'US$' : 'R$';
  const foundPrice = Number(offer.price || 0);
  const originalPrice =
    Number(offer.original_price) > 0 ? Number(offer.original_price) : foundPrice;
  const discountPct =
    Number(offer.discount) > 0
      ? Math.round(Number(offer.discount))
      : originalPrice > foundPrice && originalPrice > 0
        ? Math.round(((originalPrice - foundPrice) / originalPrice) * 100)
        : 0;

  const originalLine =
    offer.currency === 'USD' && offer.original_price_brl_estimated
      ? `Valor original: ${sym} ${originalPrice.toFixed(2)} (~R$ ${offer.original_price_brl_estimated.toFixed(2)})`
      : `Valor original: ${sym} ${originalPrice.toFixed(2)}`;

  const priceLine =
    offer.currency === 'USD' && offer.price_brl_estimated
      ? `Valor encontrado: ${sym} ${foundPrice.toFixed(2)} (~R$ ${offer.price_brl_estimated.toFixed(2)})`
      : `Valor encontrado: ${sym} ${foundPrice.toFixed(2)}`;

  return [
    `Promoção encontrada: ${offer.name}`,
    `Tipo de entrega: ${offer.delivery_type}`,
    `Loja: ${offer.store}`,
    originalLine,
    priceLine,
    `Desconto aplicado: ${discountPct}%`,
    `Link: ${offer.url}`
  ].join('\n');
}

export async function sendNotifications(
  item: MonitorItem,
  offer: Offer,
  runtimeConfig: RuntimeConfig = {}
): Promise<NotificationResult> {
  const sent: string[] = [];
  const errors: string[] = [];
  const canOverride = allowClientOverrides();

  const message = formatNotificationMessage(offer);

  // 1. E-mail via SMTP (nodemailer)
  const emailTo = (item.destinations?.['E-mail'] || item.destinations?.email || '').trim();
  const wantsEmail = item.channels.includes('E-mail') || (item.active && Boolean(emailTo));

  if (wantsEmail && isValidEmail(emailTo)) {
    const smtpHost = (canOverride && runtimeConfig.smtp_host) || process.env.SMTP_HOST;
    const smtpPort = Number((canOverride && runtimeConfig.smtp_port) || process.env.SMTP_PORT || 587);
    const smtpUser = (canOverride && runtimeConfig.smtp_user) || process.env.SMTP_USER;
    const smtpPass = (canOverride && runtimeConfig.smtp_password) || process.env.SMTP_PASSWORD;
    const smtpFrom = (canOverride && runtimeConfig.smtp_from) || process.env.SMTP_FROM || smtpUser;

    if (smtpHost && smtpUser && smtpPass) {
      try {
        const transporter = nodemailer.createTransport({
          host: smtpHost,
          port: smtpPort,
          secure: smtpPort === 465,
          connectionTimeout: 8_000,
          greetingTimeout: 8_000,
          socketTimeout: 10_000,
          auth: { user: smtpUser, pass: smtpPass }
        });
        await transporter.sendMail({
          from: smtpFrom,
          to: emailTo,
          subject: `Promoção (${offer.delivery_type}): ${offer.name.slice(0, 120)}`,
          text: message
        });
        sent.push('E-mail');
      } catch {
        errors.push('E-mail: falha ao enviar via SMTP (verifique credenciais no servidor).');
      }
    }
  }

  // 2. Telegram Bot API
  if (item.channels.includes('Telegram')) {
    const token = process.env.TELEGRAM_BOT_TOKEN || (canOverride ? runtimeConfig.telegram_bot_token : undefined);
    const chatId =
      item.destinations?.Telegram?.trim() ||
      process.env.TELEGRAM_CHAT_ID ||
      (canOverride ? runtimeConfig.telegram_chat_id : undefined);

    if (token && chatId) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8_000);
        try {
          const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: message,
              disable_web_page_preview: false
            }),
            signal: controller.signal
          });
          if (res.ok) {
            sent.push('Telegram');
          } else {
            errors.push(`Telegram: erro HTTP ${res.status}.`);
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {
        errors.push('Telegram: falha de conexão com a API.');
      }
    }
  }

  // 3. WhatsApp Cloud API (Meta)
  if (item.channels.includes('WhatsApp')) {
    const token = process.env.WHATSAPP_TOKEN || (canOverride ? runtimeConfig.whatsapp_token : undefined);
    const phoneId =
      process.env.WHATSAPP_PHONE_NUMBER_ID || (canOverride ? runtimeConfig.whatsapp_phone_number_id : undefined);
    const version =
      process.env.WHATSAPP_API_VERSION ||
      (canOverride ? runtimeConfig.whatsapp_api_version : undefined) ||
      'v23.0';
    const to = (item.destinations?.WhatsApp || '').replace(/\D/g, '');

    if (token && phoneId && to.length >= 10) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8_000);
        try {
          const res = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(phoneId)}/messages`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              to,
              type: 'text',
              text: { body: message }
            }),
            signal: controller.signal
          });
          if (res.ok) {
            sent.push('WhatsApp');
          } else {
            errors.push(`WhatsApp: erro HTTP ${res.status}.`);
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {
        errors.push('WhatsApp: falha de conexão com a API.');
      }
    }
  }

  return { sent, errors };
}
