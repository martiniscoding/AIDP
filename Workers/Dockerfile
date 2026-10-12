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

# LibreOffice, headless, for three jobs it is the only thing here that can do:
# photographing slides whose diagrams are drawn in PowerPoint's own shapes
# (aidp/parsing/slide_render.py), drawing the EMF and WMF pictures Office pastes
# into a Word file (aidp/parsing/vectors.py), and laying a .docx out so its real
# page numbers and generated heading numbers can be read off the result
# (aidp/parsing/pagination.py). Impress and Writer, no Java, no GUI. The fonts are
# what decks are written in — Carlito and Caladea match Calibri and Cambria
# metric for metric — so text in a rendered box wraps where the author put it.
# Its own layer, above the Python dependencies, so it is built once.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libreoffice-impress libreoffice-writer \
      fonts-crosextra-carlito fonts-crosextra-caladea fonts-liberation2 fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

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
