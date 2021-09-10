#!/usr/bin/env bats

setup() {
    load 'test_helper/helpers'
    _common_setup
}

@test "[BENCH] CLEAN" {
    run remove_bench
}

@test "[BENCH] BUILD" {
    run build_bench
}

@test "[BENCH] UP" {
    run ensure_bench
}

@test "[BENCH] OK" {
    run bench_ok
}

