.DEFAULT_GOAL = build
.PHONY: build test unit-test integration-test clean

test: unit-test integration-test

unit-test:
	cargo clippy --features devnet -- --allow clippy::result_large_err
	cargo test --features devnet
	
integration-test:
	anchor test --arch sbf

build:
	@echo "> Building programs"
	anchor build --arch sbf -- --features $(NETWORK) -- --no-default-features

clean:
	rm -rf node_modules .anchor
	anchor clean

# phony targets above, non-phony targets below

node_modules: package.json yarn.lock
	@echo "> Updating node modules"
	yarn
	touch node_modules
