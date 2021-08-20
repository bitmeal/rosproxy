setup() {
    load 'test_helper/helpers'
    _common_setup

    ensure_bench
}

@test "[PUB/SUB][PROXY] external -> internal" {
    # higher timeout values, as lookup and registration require additional time
    TIMEOUT_PUB=25
    TIMEOUT_SUB=20
    MSG_COUNT=10

    bench_exec_timeout ${TIMEOUT_PUB} external /ros_entrypoint.sh rostopic pub -r 100 /chat std_msgs/String hello &
    PUB=$!
    
    run bench_exec_timeout ${TIMEOUT_SUB} "-e ROS_MASTER_URI=http://rosproxy:11311/master internal" /ros_entrypoint.sh rostopic echo -n ${MSG_COUNT} /chat
    wait $PUB || true

    assert_equal $(msg_count "${output}") ${MSG_COUNT}
}