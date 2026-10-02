# syntax=docker/dockerfile:1
#
# Foyer, your own server: one static binary, and its data in a volume.
#
#   docker build -t foyer .

FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# PocketBase's SQLite is pure Go: nothing to link, nothing to install beside it.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /foyer .

FROM alpine:3
RUN adduser -D -H -u 10001 foyer && mkdir /pb_data && chown foyer /pb_data
COPY --from=build /foyer /usr/local/bin/foyer
USER foyer
# Called by its name, the binary keeps pb_data in the working directory: here
# that is /pb_data, for `serve` and for `docker compose exec` alike.
WORKDIR /
VOLUME ["/pb_data"]
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8090/api/health >/dev/null || exit 1
CMD ["foyer", "serve", "--http=0.0.0.0:8090", "--dir=/pb_data"]
