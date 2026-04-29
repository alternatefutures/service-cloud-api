FROM node:22-alpine

ENV NODE_ENV=production
ENV PORT=3000
ENV TELEGRAM_BOT_USERNAME=telegramchatdemobot

WORKDIR /app

RUN apk add --no-cache ca-certificates dumb-init \
  && addgroup -S app \
  && adduser -S app -G app

COPY docker/telegram-chat-bot/entrypoint.sh /usr/local/bin/telegram-chat-entrypoint
COPY docker/telegram-chat-bot/bot.mjs /app/bot.mjs

RUN chmod +x /usr/local/bin/telegram-chat-entrypoint \
  && chown -R app:app /app

USER app

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/telegram-chat-entrypoint"]
