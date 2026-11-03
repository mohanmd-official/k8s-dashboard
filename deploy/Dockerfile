# Build from the repo root:  docker build -f deploy/Dockerfile -t eks-lens:0.2.0 .
FROM node:22-alpine
ARG KUBECTL_VERSION=v1.31.2
ARG TARGETARCH
RUN apk add --no-cache ca-certificates curl \
 && curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" \
 && chmod +x /usr/local/bin/kubectl \
 && apk del curl
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
COPY config/accounts.example.yaml ./config/accounts.example.yaml
COPY docs ./docs
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0
EXPOSE 8080
HEALTHCHECK CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server/index.js"]
