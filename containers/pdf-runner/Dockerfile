# pdf-runner (PW4): pdfcraft-cli, built from vendor/pdfcraft at the pinned subtree ref, behind a
# small Node wrapper (server.mjs). Build from the repository root:
#   docker build -f containers/pdf-runner/Dockerfile -t pagewell/pdf-runner .
# The container needs no network: inputs come in the request body and outputs go back in the
# response. Run it with --network none outside Cloudflare; in Cloudflare the Container class sets
# enableInternet = false.

# ---- build pdfcraft-cli ----
FROM rust:1.100-bookworm AS cli
WORKDIR /src
COPY vendor/pdfcraft/ ./
# The CLI without the MCP server: the runner only uses `run`.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --locked --release -p pdfcraft-cli --no-default-features \
 && cp target/release/pdfcraft-cli /usr/local/bin/pdfcraft-cli

# ---- OCR models (the files named in vendor/pdfcraft/ATTRIBUTION.toml, checked by sha256) ----
FROM debian:bookworm-slim AS models
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /models
RUN curl -fsSLo text-detection.onnx https://ocrs-models.s3-accelerate.amazonaws.com/text-detection.onnx \
 && curl -fsSLo text-recognition.onnx https://ocrs-models.s3-accelerate.amazonaws.com/text-recognition.onnx \
 && echo "a917b23dbd9524b465df7e922641b3ff2981623df4ded5a0234004ef2fee7cfe  text-detection.onnx" | sha256sum -c - \
 && echo "86c145c2edb96c8caed5b1ebb8f44d706408922211451c309c625157dd6061c5  text-recognition.onnx" | sha256sum -c -

# ---- runtime ----
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng qpdf util-linux fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
COPY --from=cli /usr/local/bin/pdfcraft-cli /usr/local/bin/pdfcraft-cli
COPY --from=models /models/ /usr/local/share/pdfcraft/models/
COPY vendor/pdfcraft/LICENSE-APACHE vendor/pdfcraft/LICENSE-MIT vendor/pdfcraft/NOTICE /usr/local/share/pdfcraft/
WORKDIR /app
COPY containers/pdf-runner/package.json containers/pdf-runner/server.mjs containers/pdf-runner/operations.mjs ./
COPY containers/pdf-runner/test ./test
RUN useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin runner \
 && mkdir -p /jobs && chown runner /jobs
USER runner
ENV PORT=8080 PDF_RUNNER_JOBS=/jobs PDFCRAFT_CLI=/usr/local/bin/pdfcraft-cli NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.mjs"]
