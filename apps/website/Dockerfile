# Build from the repository root:
#   docker build -f apps/website/Dockerfile .
FROM caddy:2.10-alpine
COPY apps/website/Caddyfile /etc/caddy/Caddyfile
COPY apps/website/public /srv
EXPOSE 8115
