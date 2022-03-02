setup() {
    load 'test_helper/helpers'
    _common_setup

    ensure_bench
}

# spawning publisher first should deliver messages
@test "[PUB/SUB][NO PROXY] external -> internal" {
    TIMEOUT_PUB=60
    TIMEOUT_SUB=60
    SPAWN_DELAY=10
    MSG_COUNT=10
    TOPIC="/chat_${BATS_SUITE_TEST_NUMBER}"

    bench_exec_timeout ${TIMEOUT_PUB} external /ros_entrypoint.sh rostopic pub -r 100 ${TOPIC} std_msgs/String hello &
    PUB=$!
    
    sleep ${SPAWN_DELAY}
    run bench_exec_timeout ${TIMEOUT_SUB} "-e ROS_MASTER_URI=http://roscore:11311/ internal" /ros_entrypoint.sh rostopic echo -n ${MSG_COUNT} ${TOPIC}
    wait $PUB || true

    assert_equal $(msg_count "${output}") ${MSG_COUNT}
}
