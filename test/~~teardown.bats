#!/usr/bin/env bats

setup() {
    load 'test_helper/helpers'
    _common_setup
}

@test "[BENCH] DOWN" {
    teardown_bench
    
    run bench_ok
    assert_failure
}