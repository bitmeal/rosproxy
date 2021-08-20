#!/usr/bin/env bash

## test for docker
if ! docker --version > /dev/null ; then
    echo "docker executable not found!" >2
    exit 1
fi

## test for docker-compose
if ! docker-compose --version > /dev/null ; then
    echo "docker-compose executable not found!" >2
    exit 1
fi


## test for and checkout bats
if ! bats/bin/bats --version > /dev/null ; then
    echo "# bats not found; checking out submodules"
    git submodule update --init --recursive > /dev/null
fi

## run tests
export LC_COLLATE=C
bats/bin/bats ${@} .