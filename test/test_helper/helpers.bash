#!/usr/bin/env bash

_common_setup() {
    load 'test_helper/bats-support/load'
    load 'test_helper/bats-assert/load'
    # get the containing directory of this file
    # use $BATS_TEST_FILENAME instead of ${BASH_SOURCE[0]} or $0,
    # as those will point to the bats executable's location or the preprocessed file respectively
    BENCH_DIR="$( cd "$( dirname "$BATS_TEST_FILENAME" )/bench" >/dev/null 2>&1 && pwd )"
}

# print to fd 3, prepended by '#'
# prints from arguments and/or stdin
print() {
    if [ ${#} -ne 0 ]; then
        echo -e "${@}" | sed 's/^/# /' >&3
    else
        cat - | sed 's/^/# /' >&3
    fi
}

bench_ok() {

    SERVICES_ALL="$(cd ${BENCH_DIR} && docker-compose ps --services | sort)"
    SERVICES_UP="$(cd ${BENCH_DIR} && docker-compose ps --services --filter "status=running" | sort)"

    assert_equal "${SERVICES_ALL}" "${SERVICES_UP}"

    unset SERVICES_ALL
    unset SERVICES_UP
}

ensure_bench() {

}