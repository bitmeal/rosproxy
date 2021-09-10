setup() {
    load 'test_helper/helpers'
    _common_setup

    ensure_bench
}

@test "[PROXY] allocate ports from range" {
    PORT_RANGE=$(run_in_bench cat docker-compose.yml | yq eval '.services.rosproxy.command | .[.[] | select(. == "-r") | path | .[-1] + 1]' -)
    PORT_RANGE_LOWER=$(echo "${PORT_RANGE}" | grep -oP '^\d+')
    PORT_RANGE_UPPER=$(echo "${PORT_RANGE}" | grep -oP '\d+$')

    print "port range: ${PORT_RANGE_LOWER}-${PORT_RANGE_UPPER}"
    # evaluate rosproxy logfiles for allocated ports; relies on nodes spun up before
    run run_in_bench sh -c "docker-compose logs rosproxy | grep 'Creating proxy:' | sed -E 's/^.*Creating proxy: ([[:digit:]]+).*/\1/' | sort"

    [ $(echo "${output}" | head -n 1) -ge ${PORT_RANGE_LOWER} ]
    [ $(echo "${output}" | tail -n 1) -le ${PORT_RANGE_UPPER} ]
}

