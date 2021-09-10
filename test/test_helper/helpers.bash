#!/usr/bin/env bash

_common_setup() {
    load 'test_helper/bats-support/load'
    load 'test_helper/bats-assert/load'

    BENCH_DIR="$( cd "$( dirname "$BATS_TEST_FILENAME" )/bench" >/dev/null 2>&1 && pwd )"
    # print "test bench in: ${BENCH_DIR}"
}

# print to fd 3, prefixed by '#'
# prints from arguments and/or stdin
print() {
    ([ ${#} -ne 0 ] && echo -e "${@}" || cat -) | sed 's/^/# /' >&3
    # if [ ${#} -ne 0 ]; then
    #     echo -e "${@}" | sed 's/^/# /' >&3
    # else
    #     cat - | sed 's/^/# /' >&3
    # fi
}

yq() {
  docker run --rm -i -v "${PWD}":/workdir mikefarah/yq "$@"
}

# count ros messages from terminal
# reads from parameters or stdin
# removes WARNING lines!
msg_count() {
    ([ ${#} -ne 0 ] && echo -e "${@}" || cat -) | sed '/WARNING:/d' | yq eval-all '[select(.) | .data] | length' -
}

run_in_bench() {
    (cd ${BENCH_DIR} && "${@}")
}

bench_exec() {
    export COMPOSE_INTERACTIVE_NO_CLI=1
    run_in_bench docker-compose exec -T "${@}"
}

bench_exec_timeout() {
    TIMEOUT=${1}
    shift
    SERVICE_ARGS=${1}
    shift

    bench_exec ${SERVICE_ARGS} timeout ${TIMEOUT} sh -c "${*}"
}

bench_ok() {
    SERVICES_ALL="$(run_in_bench docker-compose ps --services | sort | tr '\n' ',')"
    SERVICES_UP="$(run_in_bench docker-compose ps --services --filter "status=running" | sort | tr '\n' ',')"

    if [ "${SERVICES_ALL}" == "${SERVICES_UP}" ]; then
        unset SERVICES_ALL
        unset SERVICES_UP

        return 0
    else
        print "Test bench not OK! has: ${SERVICES_UP::-1}; wants: ${SERVICES_ALL::-1}"

        unset SERVICES_ALL
        unset SERVICES_UP

        return 1
    fi
}

ensure_bench() {
    print "ensuring test bench availability..."

    if [ -z "${BENCH_DIR}" ]; then
        print "test bench directory not set"
        exit 1
    fi

    if ! bench_ok; then
        print "bringing up test bench..."
        print "test bench in: ${BENCH_DIR}"

        if [ ! -d ${BENCH_DIR}/data/ ]; then
            print "creating data/"
            mkdir -p ${BENCH_DIR}/data/
        fi
        if [ ! -f ${BENCH_DIR}/data/resolv.conf ]; then
            print "creating data/resolv.conf"
            touch ${BENCH_DIR}/data/resolv.conf
        fi

        run_in_bench docker-compose up -d
        bench_ok
    else
        print "bench OK"
    fi
}

teardown_bench() {
    run_in_bench docker-compose down
    remove_bench
}

remove_bench() {
    yes | run_in_bench docker-compose rm
}

build_bench() {
    run_in_bench docker-compose build
}