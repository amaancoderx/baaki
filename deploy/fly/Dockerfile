# The voice bridge needs a process that stays alive holding two sockets at
# once: Twilio's media stream in, the live model out. That rules out serverless:
# a Vercel Function opens the outbound socket and then never receives a frame.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY lib ./lib
COPY server.ts ./
RUN npx tsc

FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/server.js"]
