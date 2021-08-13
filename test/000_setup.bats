#!/usr/bin/env bats

setup_file() {
    load 'test_helper/common-setup'
    _common_setup

    print ${BENCH_DIR}

    if [ bench_ok ]; then
        print bench OK
    else
        print bench DOWN
    fi
}