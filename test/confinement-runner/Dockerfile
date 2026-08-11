# The digest matches the repository's production Docker build. Tool versions
# below match the two committed source authorities used by the wave-four join.
FROM public.ecr.aws/docker/library/node:22-bookworm@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a

ARG TARGETARCH
ENV GO_VERSION=1.26.5

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bubblewrap \
      ca-certificates \
      curl \
      dumb-init \
      git \
      jq \
      procps \
      python3 \
      rsync \
      tmux \
      vim \
    && rm -rf /var/lib/apt/lists/*

# Go is installed from the official archive because Debian's package lags the
# companion's go.mod. Both Docker-supported architectures are checksum-pinned.
RUN case "${TARGETARCH}" in \
      amd64) \
        archive="go1.26.5.linux-amd64.tar.gz"; \
        sha256="5c2c3b16caefa1d968a94c1daca04a7ca301a496d9b086e17ad77bb81393f053" \
        ;; \
      arm64) \
        archive="go1.26.5.linux-arm64.tar.gz"; \
        sha256="fe4789e92b1f33358680864bbe8704289e7bb5fc207d80623c308935bd696d49" \
        ;; \
      *) echo "unsupported Docker architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && test "${archive}" = "go${GO_VERSION}.linux-${TARGETARCH}.tar.gz" \
    && curl -fsSLo "/tmp/${archive}" "https://go.dev/dl/${archive}" \
    && printf '%s  %s\n' "${sha256}" "/tmp/${archive}" | sha256sum -c - \
    && tar -C /usr/local -xzf "/tmp/${archive}" \
    && rm "/tmp/${archive}"

ENV PATH="/usr/local/go/bin:${PATH}" \
    GOTOOLCHAIN=local

RUN npm install --global pnpm@10.34.5 @openai/codex@0.147.0 \
    && test "$(pnpm --version)" = "10.34.5" \
    && test "$(codex --version)" = "codex-cli 0.147.0" \
    && test "$(go version | awk '{print $3}')" = "go${GO_VERSION}"

# The launch translator is part of the reviewed runner image, not either
# mutable source mount. Its exact path is the Go profile's probed executable and
# the Comis operator allow entry's hash-pinned command.
COPY --chmod=0755 test/confinement-runner/wave4-codex-launcher.sh /usr/local/bin/wave4-codex-launcher
COPY --chmod=0755 test/confinement-runner/e0-codex-launcher.sh /usr/local/bin/e0-codex-launcher
COPY --chmod=0755 test/confinement-runner/wave4-report-capture.sh /usr/local/lib/wave4/devcrew-report
COPY test/confinement-runner/wave4-reporter-client-diagnostic.go /usr/local/share/wave4-reporter-client-diagnostic.go

# The upstream Node image already owns uid/gid 1000. Rename that account so
# every spike, including bwrap itself, runs as an unprivileged service user.
RUN groupmod --new-name comis node \
    && usermod --login comis --home /home/comis --move-home node \
    && install -d -o comis -g comis \
      /home/comis/.cache/go-build \
      /home/comis/.comis/models \
      /home/comis/.codex \
      /home/comis/.local/share/pnpm \
      /home/comis/go/pkg/mod \
      /runner \
      /workspace/comis \
      /workspace/comis-dev-crew \
    && chown -R comis:comis /home/comis

ENV CODEX_HOME=/home/comis/.codex \
    GOMODCACHE=/home/comis/go/pkg/mod \
    GOCACHE=/home/comis/.cache/go-build

USER comis
WORKDIR /workspace/comis
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["/bin/bash"]
