FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json* tsconfig.json ./
RUN npm install
COPY src ./src
RUN npx tsc


FROM node:22-bookworm-slim

# ffmpeg supplies libx264 and the lut3d filter; exiftool reads the Sony
# acquisition metadata that carries the picture profile.
RUN apt-get update \
    && apt-get install --no-install-recommends -y ffmpeg libimage-exiftool-perl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY tools ./tools
COPY luts ./luts

ENV NODE_ENV=production \
    WORK_DIR=/work \
    LUT_PATH=/app/luts/slog3-to-rec709.cube \
    PORT=8710

RUN mkdir -p /work && chown node:node /work
USER node
VOLUME ["/work"]
EXPOSE 8710

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8710)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/index.js"]
CMD ["serve"]
