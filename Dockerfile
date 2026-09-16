FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json* tsconfig.json ./
RUN npm install
COPY src ./src
RUN npx tsc


FROM node:22-bookworm-slim

# ffmpeg supplies libx264 and the lut3d filter; exiftool reads the Sony
# acquisition metadata that carries the picture profile.
#
# exiftool is installed from source at a pinned version rather than from Debian,
# which ships 12.57. That version reads only part of the acquisition record on
# longer clips: it reported three items where 13.59 reports fourteen on the same
# bytes, and CaptureGammaEquation was not among the three, so every affected clip
# looked like it had no picture profile. exiftool is pure Perl, so this is an
# extract and a symlink.
ARG EXIFTOOL_VERSION=13.59
RUN apt-get update \
    && apt-get install --no-install-recommends -y ffmpeg perl ca-certificates curl \
    && curl -fsSL "https://github.com/exiftool/exiftool/archive/refs/tags/${EXIFTOOL_VERSION}.tar.gz" -o /tmp/exiftool.tar.gz \
    && tar -xzf /tmp/exiftool.tar.gz -C /opt \
    && mv "/opt/exiftool-${EXIFTOOL_VERSION}" /opt/exiftool \
    && ln -s /opt/exiftool/exiftool /usr/local/bin/exiftool \
    && rm /tmp/exiftool.tar.gz \
    && apt-get purge -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* \
    && exiftool -ver

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY tools ./tools
COPY luts ./luts

ENV NODE_ENV=production \
    WORK_DIR=/work \
    LUT_PATH=/app/luts/lc_709_type_a.cube \
    PORT=8710

RUN mkdir -p /work && chown node:node /work
USER node
VOLUME ["/work"]
EXPOSE 8710

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8710)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/index.js"]
CMD ["serve"]
