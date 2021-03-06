setup() {
    load 'test_helper/helpers'
    _common_setup

    ensure_bench
}

@test "[PUB/SUB][PROXY] internal -> external" {
    TIMEOUT_PUB=60
    TIMEOUT_SUB=60
    SPAWN_DELAY=10
    MSG_COUNT=10
    TOPIC="/chat_${BATS_SUITE_TEST_NUMBER}"

    bench_exec_timeout ${TIMEOUT_PUB} "-e ROS_MASTER_URI=http://rosproxy:11311/master internal" /ros_entrypoint.sh rostopic pub -r 100 ${TOPIC} std_msgs/String hello &
    PUB=$!
    
    sleep ${SPAWN_DELAY}
    run bench_exec_timeout ${TIMEOUT_SUB} external /ros_entrypoint.sh rostopic echo -n ${MSG_COUNT} ${TOPIC}
    wait $PUB || true

    assert_equal $(msg_count "${output}") ${MSG_COUNT}
}