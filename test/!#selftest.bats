setup() {
    load 'test_helper/helpers'
    _common_setup

    ensure_bench
}

@test "[SELFTEST] exec external" {
    run bench_exec external echo hello
    assert_output "hello"
}

@test "[SELFTEST] exec internal" {
    run bench_exec internal echo hello
    assert_output "hello"
}

@test "[SELFTEST] exec background timeout pass" {
    run bench_exec_timeout 1 internal "sleep 5; echo hello"
    refute_output "hello"
}

@test "[SELFTEST] exec background timeout fail" {
    run bench_exec_timeout 1 internal "echo hello"
    assert_output "hello"
}

@test "[SELFTEST] exec background timeout parameters" {
    run bench_exec_timeout 1 "-e MSG=hello internal" 'echo ${MSG}'
    assert_output "hello"
}

