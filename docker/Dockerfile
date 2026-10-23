FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    gnupg \
    curl \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code @openai/codex

ENV COREPACK_HOME=/usr/local/share/corepack
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable \
 && corepack prepare pnpm@latest --activate \
 && corepack prepare yarn@stable --activate \
 && chmod -R a+rwX /usr/local/share/corepack

ARG PLAYWRIGHT_VERSION=1.49.1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV NODE_PATH=/usr/local/lib/node_modules
RUN npm install -g playwright@${PLAYWRIGHT_VERSION} \
 && npx playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* \
 && chmod -R a+rX /ms-playwright

ARG UID=1000
ARG GID=1000
RUN userdel -r node 2>/dev/null || true \
 && groupadd -g ${GID} agent \
 && useradd -m -u ${UID} -g ${GID} agent

RUN mkdir -p /home/agent/node_modules \
 && ln -sfn /usr/local/lib/node_modules/playwright /home/agent/node_modules/playwright \
 && chown -R ${UID}:${GID} /home/agent/node_modules

RUN git config --system --add safe.directory '*'

USER agent
WORKDIR /home/agent/workspace

CMD ["sleep", "infinity"]
