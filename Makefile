.PHONY: install build test lint fmt clean ci

install:
	npm ci

build:
	npm run build

test:
	npm test

lint:
	npx tsc --noEmit

fmt:
	npx prettier --write src/ tests/

clean:
	rm -rf dist/ coverage/ *.tsbuildinfo

ci: lint test build
