#!/usr/bin/env bats

setup() {
    load 'test_helper/helpers'
    _common_setup

    ensure_bench
}

@test "[BENCH] UP" {
    bench_ok
}