# ROSProxy
> A proxy for ROS... 🤦‍♂️

*TODO*

## Testing
> ⚠ Test requires *docker* and *docker-compose*!

```bash
# from test/
$ ./test.bash
```

Tests use `bats` testing framework. Running `test.bash` will check for *docker*, *docker-compose* and checkout *bats* submodules if not present. Info and error messages generated by `test.bash` are **not** *TAP* compliant! To ensure machine readable output, init submodules manually! Parameters passed to `test.bash` are forwarded to `bats` executable.

* Tests are executed in a *docker-compose* setup, recreating a NAT routed setup with internal and external networks.
* Use ASCII collation order `LC_COLLATE=C` when running bats without using `test.bash`