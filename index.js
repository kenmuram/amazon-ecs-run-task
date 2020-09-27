const core = require('@actions/core');
const aws = require('aws-sdk');
const path = require('path');
const fs = require('fs');
const yaml = require('yaml');

const WAIT_DEFAULT_DELAY_SEC = 5;
const DEFAULT_WAIT_MINUTES = 360;
const FIRST = 0

async function waitForTaskStopped(ecs, cluster, taskArns, waitForMinutes) {
    const waitForParameter = {
        cluster: cluster,
        tasks: taskArns,
        $waiter: {
            delay: WAIT_DEFAULT_DELAY_SEC,
            maxAttempts: (waitForMinutes * 60) / WAIT_DEFAULT_DELAY_SEC
        }
    };

    core.debug('waitForParameter - ' + JSON.stringify(waitForParameter));
    const waitForResponse = await ecs.waitFor('tasksStopped', waitForParameter).promise();
    core.debug('waitForResponse - ' + JSON.stringify(waitForResponse));
}

async function confirmForTaskSuccess(ecs, cluster, taskArns) {
    const describeTasksParameter = {cluster: cluster, tasks: taskArns}

    core.debug('describeTasksParameter - ' + JSON.stringify(describeTasksParameter));
    const describeTasksResponse = await ecs.describeTasks(describeTasksParameter).promise();
    core.debug('describeTasksResponse - ' + JSON.stringify(describeTasksResponse));

    confirmOfFailure(describeTasksResponse.failures)

    const failures = []

    for (let i = 0; i < describeTasksResponse.tasks.length; i++) {
        const containers = describeTasksResponse.tasks[i].containers

        for (let j = 0; j < containers.length; j++) {
            if (containers[j].exitCode !== 0) {
                failures.push(containers[j].reason)
            }
        }
    }

    if (failures.length > 0) {
        throw new Error(failures.join("\n"));
    }
}

function confirmOfFailure(failures) {
    if (failures && failures.length > 0) {
        const failure = failures[FIRST];
        throw new Error(`${failure.arn} is ${failure.reason}`);
    }
}

async function run() {
    try {
        const ecs = new aws.ECS({});

        // get input
        const cluster = core.getInput('cluster', { required: true });
        const service = core.getInput('service', { required: true });
        const count = core.getInput('count', { required: true });
        const taskDefinitionFile = core.getInput('task-definition', { required: true });
        const waitForFinish = core.getInput('wait-for-finish', { required: true });
        const waitForMinutes = core.getInput('wait-for-minutes', { required: false }) || DEFAULT_WAIT_MINUTES;

        // get service info
        const describeServicesParameter = {
            cluster: cluster,
            services: [service]
        }

        core.debug('describeServicesParameter - ' + JSON.stringify(describeServicesParameter));
        const describeServicesResponse = await ecs.describeServices(describeServicesParameter).promise();
        core.debug('describeServicesResponse - ' + JSON.stringify(describeServicesResponse));

        confirmOfFailure(describeServicesResponse.failures)

        // register task definition
        const taskDefinitionFilePath = path.isAbsolute(taskDefinitionFile) ? taskDefinitionFile : path.join(process.env.GITHUB_WORKSPACE, taskDefinitionFile);
        const taskDefinitionString = fs.readFileSync(taskDefinitionFilePath, 'utf8');
        const registerTaskDefinitionParameter = yaml.parse(taskDefinitionString);

        core.debug('registerTaskDefinitionParameter - ' + JSON.stringify(registerTaskDefinitionParameter));
        const registerTaskDefinitionResponse = await ecs.registerTaskDefinition(registerTaskDefinitionParameter).promise();
        core.debug('registerTaskDefinitionResponse - ' + JSON.stringify(registerTaskDefinitionResponse));

        // run task
        const runTaskParameter = {
            cluster: cluster,
            count: count,
            launchType: describeServicesResponse.services[FIRST].launchType,
            networkConfiguration: describeServicesResponse.services[FIRST].networkConfiguration,
            taskDefinition: registerTaskDefinitionResponse.taskDefinition.taskDefinitionArn
        }

        core.debug('runTaskParameter - ' + JSON.stringify(runTaskParameter));
        const runTaskResponse = await ecs.runTask(runTaskParameter).promise();
        core.debug('runTaskResponse - ' + JSON.stringify(runTaskResponse));

        confirmOfFailure(runTaskResponse.failures)

        // wait & confirm success
        const taskArns = runTaskResponse.tasks.map(task => task.taskArn);

        if (waitForFinish && waitForFinish.toLowerCase() === 'true') {
            await waitForTaskStopped(ecs, cluster, taskArns, waitForMinutes);
            await confirmForTaskSuccess(ecs, cluster, taskArns);
        }

    } catch (error) {
        core.setFailed(error.message);
        core.debug(error.stack);
    }
}

run();
