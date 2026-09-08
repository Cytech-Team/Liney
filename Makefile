.PHONY: help check run package clean

help:
	@echo "Liney 0.2 — manager commands"
	@echo "  make check    cargo check + bun test (35)"
	@echo "  make run      run GTK app (cache-first)"
	@echo "  make build    build release GTK + engine"
	@echo "  make package  build + tar + verify"
	@echo "  make install  install to ~/.local"
	@echo "  tree: app/ (UI)  engine/ (data)  docs/ARCHITECTURE.md"

check:
	cargo check --manifest-path app/Cargo.toml
	/home/namkrub/.bun/bin/bun test

run:
	/home/namkrub/.bun/bin/bun run desktop:dev

build:
	/home/namkrub/.bun/bin/bun run engine:build
	cargo build --release --manifest-path app/Cargo.toml

package: build
	sh scripts/package-tar.sh
	sh scripts/verify-release.sh
	ls -lh release/*.tar.gz

install: build
	sh scripts/install-local.sh

clean:
	rm -rf app/target build
