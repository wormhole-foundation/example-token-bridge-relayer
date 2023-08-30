.DEFAULT_GOAL = build
.PHONY: build test unit-test integration-test clean

test: unit-test integration-test

unit-test:
	cargo clippy --features devnet -- --allow clippy::result_large_err
	cargo test --features devnet

### TODO: Perform another test by building w/o feature "devnet" to test immutability after initialize
integration-test:
	anchor test --arch sbf

build:
	@echo "> Building programs"
	anchor build --arch sbf -- --features $(NETWORK) -- --no-default-features

clean:
	rm -rf node_modules .anchor
	anchor clean

#phony targets above, non-phony targets below

ifneq ($(NETWORK), $(shell cat target/network_changed 2>/dev/null))
#force update of target/network_changed if value of NETWORK changed from last time
.PHONY: target/network_changed
endif
target/network_changed:
	echo $(NETWORK) > target/network_changed

node_modules: package.json yarn.lock
	@echo "> Updating node modules"
	yarn
	touch node_modules
