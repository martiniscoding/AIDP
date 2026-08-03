# One image, three roles. STAGE picks the loop at runtime — see aidp/__main__.py.
#
# The customer's Solution Architecture §4.3 asks for immutable images with
# externalised configuration, which is exactly this: nothing stage-specific is
# baked in, so the same digest runs parse, chunk and embed.
FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Dependencies in their own layer so code changes don't reinstall PyMuPDF.
COPY pyproject.toml ./
RUN pip install --upgrade pip && pip install .

COPY aidp ./aidp

# Runs as a non-root user; the storage volume is chowned to match.
RUN useradd --create-home --uid 10001 worker \
 && mkdir -p /app/.storage \
 && chown -R worker:worker /app
USER worker

# No default STAGE. A container started without one should fail immediately and
# say so, rather than quietly running the wrong loop.
ENTRYPOINT ["python", "-m", "aidp"]
