FROM python:3.12-slim as builder

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

# Install dependencies (sem instalar o projeto local ainda)
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# Copy application
COPY main.py index.html ./
COPY css/ css/
COPY js/  js/
COPY rs_movie/ rs_movie/

# Instala o pacote local (rs_movie)
RUN uv sync --frozen --no-dev

# Pontos de montagem para volumes externos
RUN mkdir -p /app/subtitle /app/oracle

EXPOSE 8080

CMD ["/app/.venv/bin/start"]
