#!/usr/bin/env node

var AWS = require("aws-sdk");
//forçar leitura de acessos para aws , descomentar as linhas abaixo com dados de sua conta
//AWS.config.accessKeyId     = "XXXXXXXXXXXXX";
//AWS.config.secretAccessKey = "XXXXXXXXXXXXX";
//AWS.config.sessionToken    = "XXXXXXXXXXXXX";


//lendo dependencias
var proxy = require('proxy-agent');
const fs = require('fs');
const util = require('util');
const path = require('path');
const process = require('process');
const deepmerge = require('deepmerge');
const cliargs = require('commander');
const cliprogress = require('cli-progress');
const logplease = require('logplease');
const _colors = require('colors');
const pjson = require('./package.json');
const { openStdin } = require("process");
const CLI = true;

logplease.setLogLevel('NONE');
const awslog = logplease.create('AWS');
AWS.config.logger = awslog;

var cli_resources = [];
var check_objects = [];

function blockUI() { }
function unblockUI() { }
function nav(str) {
    return str.replace(/\s/g, "").replace(/\,/g, "").replace(/\-/g, "").replace(/\&amp\;/g, "And");
}
async function getResourceTags(arn) {
    if (!arn) {
        return null;
    }

    if (arn.split(":").length < 7 && !arn.split(":")[5].includes("/")) {
        return null;
    }

    var service = arn.split(":")[2];
    var type = arn.split(":")[5].split("/")[0];

    if (!resource_tag_cache[ service/*+ "." + type*/ ]) {
        resource_tag_cache[service] = [];
        
        await sdkcall("ResourceGroupsTaggingAPI", "getResources", {
            ResourceTypeFilters: [ service/* + "." + type*/ ]
        }, false).then((data) => {
            resource_tag_cache[ service/* + "." + type*/ ] = data.ResourceTagMappingList;
        }).catch(() => { });
        setTimeout((k) => {
            delete resource_tag_cache[k];
        }, 20000, service/* + "." + type*/); // 20s cache
    }

    for (var res of resource_tag_cache[ service/* + "." + type*/ ]) {
        var resarnparts = res['ResourceARN'].split(":");
        resarnparts[3] = "";
        resarnparts[4] = "";
        var arnparts = arn.split(":");
        arnparts[3] = "";
        arnparts[4] = "";

        if (resarnparts.join(":") == arnparts.join(":")) {
            return res['Tags'].filter(tag => !tag['Key'].startsWith("aws:"));
        }
    }

    return null;
}
var resource_tag_cache = {};
const iaclangselect = "typescript";

function $(selector) { return new $obj(selector) }
$obj = function (selector) { };
$obj.prototype.bootstrapTable = function (action, data) {
    if (action == "append") {
        cli_resources = [...cli_resources, ...data];
    }
}
$obj.prototype.deferredBootstrapTable = function (action, data) {
    if (action == "append") {
        cli_resources = [...cli_resources, ...data];
    }
}
$.notify = function () { }

var region = process.env.AWS_DEFAULT_REGION || process.env.AWS_REGION || null;
try {
    region = new AWS.IniLoader().loadFrom({isConfig: true})['default']['region'];
} catch(err) {}
if (!region) {
    region = 'us-east-1';
}

var stack_parameters = [];
//lendo arquivos de funções externas
eval(fs.readFileSync(path.join(__dirname, 'deepmerge.js'), 'utf8'));
eval(fs.readFileSync(path.join(__dirname, 'mappings.js'), 'utf8'));
eval(fs.readFileSync(path.join(__dirname, 'datatables.js'), 'utf8'));
//lendo arquivos de serviços que serão mapeados
var items = fs.readdirSync(path.join(__dirname, 'services'));
for (var i=0; i<items.length; i++) {
    eval(fs.readFileSync(path.join(__dirname, 'services', items[i]), 'utf8'));
};

f2log = function(msg){};
f2trace = function(err){};
//iniciando o sistema na função main
async function main(opts) {
    //variavel para resolver o problema do proxy  

    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = 0;
  
    if (!opts.outputRawData && !opts.outputCloudformation && !opts.outputTerraform) {
        throw new Error('You must specify an output type');
    }
    //pegando as variaveis das opções na linha de comando
    if (opts.debug) {
        f2log = function(msg){ console.log(msg); };
        f2trace = function(err){ console.trace(err); };
        f2debug = function(msg){ console.log(Date.now().toString() + ": " + msg); };
    }

    if (opts.includeDefaultResources) {
        include_default_resources = true;
    }

    if (opts.profile) {
        AWS.config.credentials = new AWS.SharedIniFileCredentials({profile: opts.profile});
    }

    if (AWS.config.region) {
        region = AWS.config.region;
    }

    if (opts.region) {
        AWS.config.update({region: opts.region});
        region = opts.region;
    }

    if (opts.proxy) {
        AWS.config.update({httpOptions: {agent: proxy(opts.proxy)}});
    }

    if (opts.services && opts.services.toUpperCase() == "ALL") {
        opts.services = null;
    }

    if (opts.excludeServices && opts.services) {
        throw new Error('Please do not use --exclude-services and --services simultaneously');
    }

    var includeExclude = opts.excludeServices || opts.services;
    if (includeExclude) {
        var includeExcludeServices = includeExclude.split(",").map(x => x.toLowerCase());
        for (var i in sections) {
            var includes = includeExcludeServices.includes(nav(sections[i].service).toLowerCase());
            if ((opts.services && !includes) || (opts.excludeServices && includes)) {
                delete sections[i];
            }
        }
        sections = sections.filter(val => val); // reindex
    }

    if (opts.cfnDeletionPolicy && opts.cfnDeletionPolicy != "Delete" && opts.cfnDeletionPolicy != "Retain") {
        throw new Error('You must specify --cfn-deletion-policy value in [Delete, Retain]');
    }

    outputMapCdk = function(){};
    outputMapTroposphere = function(){};
    outputMapPulumi = function(){};
    outputMapCdktf = function(){};
    if (!opts.outputCloudformation) { outputMapCfn = function(){}; }
    if (!opts.outputTerraform) { outputMapTf = function(){}; }

    const b1 = new cliprogress.SingleBar({
        format: _colors.cyan('{bar}') + '  {percentage}% ({value}/{total} services completed)',
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        hideCursor: false
    });

    b1.start(sections.length, 0);

    await Promise.all(
        sections
        .map(section => {
            let dtname = 'updateDatatable' + nav(section.category) + nav(section.service);
            return eval(dtname);
        })
        .map(work =>
            new Promise(async resolve => {
                try {
                    //debugger; //fase inicial  extrair os dados da aws
                    await work();
                } catch (err) {
                    awslog.warn(util.format('updateDatatable failed: %j', err));
                } finally {
                    b1.increment();
                    resolve();
                }
            })
        )
    );

    b1.stop();

    if (opts.sortOutput) {
        cli_resources = cli_resources.sort((a, b) => (a.f2id > b.f2id) ? 1 : -1);
    }

    if (opts.outputRawData) {
        fs.writeFileSync(opts.outputRawData, JSON.stringify(cli_resources, null, 4));
    }

    if (opts.outputCloudformation || opts.outputTerraform) {
        var output_objects = [];

        for (var i=0; i<cli_resources.length; i++) {
            if (opts.searchFilter) {
                var jsonres = JSON.stringify(cli_resources[i]);
                if (opts.searchFilter.includes(",")) {
                    for (var searchterm of opts.searchFilter.split(",")) {
                        if (jsonres.includes(searchterm)) {
                            output_objects.push({
                                'id': cli_resources[i].f2id,
                                'type': cli_resources[i].f2type,
                                'data': cli_resources[i].f2data,
                                'region': cli_resources[i].f2region
                            });
                            break;
                        }
                    }
                } else {
                    if (jsonres.includes(opts.searchFilter)) {
                        output_objects.push({
                            'id': cli_resources[i].f2id,
                            'type': cli_resources[i].f2type,
                            'data': cli_resources[i].f2data,
                            'region': cli_resources[i].f2region
                        });
                    }
                }
            } else {
                output_objects.push({
                    'id': cli_resources[i].f2id,
                    'type': cli_resources[i].f2type,
                    'data': cli_resources[i].f2data,
                    'region': cli_resources[i].f2region
                });
            }
        }
        //debugger; //fase de mapear os dados para o parser para output_objects
        var tracked_resources = performF2Mappings(output_objects);
        //debugger; //fase de transformar os dados anteriores para o formato terraform
        var mapped_outputs = compileOutputs(tracked_resources, opts.cfnDeletionPolicy);
        generateDiagram()
        if (opts.outputCloudformation) {
            fs.writeFileSync(opts.outputCloudformation, mapped_outputs['cfn']);
        }

        if (opts.outputTerraform) {
            fs.writeFileSync(opts.outputTerraform, mapped_outputs['tf']);
        }
    }
}

let validation = false;
cliargs
    .version(pjson.version)
    .command('generate')
    .description('generates outputs and writes them to the specified file')
    .option('--output-cloudformation <filename>', 'filename for CloudFormation output')
    .option('--output-terraform <filename>', 'filename for Terraform output')
    .option('--output-raw-data <filename>', 'filename for debug output (full)')
    .option('--cfn-deletion-policy <Delete|Retain>', 'add DeletionPolicy in CloudFormation output')
    .option('--search-filter <value>', 'search filter for discovered resources (can be comma separated)')
    .option('--services <value>', 'list of services to include (can be comma separated (default: ALL))')
    .option('--exclude-services <value>', 'list of services to exclude (can be comma separated)')
    .option('--sort-output', 'sort resources by their ID before outputting')
    .option('--include-default-resources', 'include default resources such as default VPCs and their subnets')
    .option('--region <regionname>', 'overrides the default AWS region to scan')
    .option('--profile <profilename>', 'uses the profile specified from the shared credentials file')
    .option('--proxy <protocol://host:port>', 'use proxy')
    .option('--debug', 'log debugging messages')
    .action(async (opts) => {
        // The followings are here to silence Node runtime complaining about event emitter listeners
        // due to the number of TLS requests that suddenly go out to AWS APIs. This is harmless here
        require('events').EventEmitter.defaultMaxListeners = 1000;
        process.setMaxListeners(0);
        validation = true;
        try {
            await main(opts);
        } catch(err) {
            console.log("\nERROR: " + err.message + "\n")
            cliargs.help();
        }
    });

cliargs.parse(process.argv);
if (!validation) {
    cliargs.help();
}
XXXXXXXXXXXXXXXXXX
/* ========================================================================== */
// Auto Scaling
/* ========================================================================== */

sections.push({
    'category': 'Management &amp; Governance',
    'service': 'Auto Scaling',
    'resourcetypes': {
        'Scaling Plans': {
            'columns': [
                [
                    {
                        field: 'state',
                        checkbox: true,
                        rowspan: 2,
                        align: 'center',
                        valign: 'middle'
                    },
                    {
                        title: 'Name',
                        field: 'name',
                        rowspan: 2,
                        align: 'center',
                        valign: 'middle',
                        sortable: true,
                        formatter: primaryFieldFormatter,
                        footerFormatter: textFormatter
                    },
                    {
                        title: 'Properties',
                        colspan: 4,
                        align: 'center'
                    }
                ],
                [
                    {
                        field: 'version',
                        title: 'Version',
                        sortable: true,
                        editable: true,
                        footerFormatter: textFormatter,
                        align: 'center'
                    },
                    {
                        field: 'creationtime',
                        title: 'Creation Time',
                        sortable: true,
                        editable: true,
                        formatter: dateFormatter,
                        footerFormatter: textFormatter,
                        align: 'center'
                    }
                ]
            ]
        }
    }
});

async function updateDatatableManagementAndGovernanceAutoScaling() {
    blockUI('#section-managementandgovernance-autoscaling-scalingplans-datatable');

    await sdkcall("AutoScalingPlans", "describeScalingPlans", {
        // no params
    }, true).then((data) => {
        $('#section-managementandgovernance-autoscaling-scalingplans-datatable').deferredBootstrapTable('removeAll');

        data.ScalingPlans.forEach(scalingPlan => {
            $('#section-managementandgovernance-autoscaling-scalingplans-datatable').deferredBootstrapTable('append', [{
                f2id: scalingPlan.ScalingPlanName,
                f2type: 'autoscaling.scalingplan',
                f2data: scalingPlan,
                f2region: region,
                name: scalingPlan.ScalingPlanName,
                version: scalingPlan.ScalingPlanVersion,
                creationtime: scalingPlan.CreationTime
            }]);
        });

        unblockUI('#section-managementandgovernance-autoscaling-scalingplans-datatable');
    });
}

service_mapping_functions.push(function(reqParams, obj, tracked_resources){
    

    if (obj.type == "autoscaling.policy") {
        // debugger;
        reqParams.cfn['AutoScalingGroupName'] = obj.data.AutoScalingGroupName;
        reqParams.tf['autoscaling_group_name'] = obj.data.AutoScalingGroupName;
        reqParams.tf['name'] = obj.data.AutoScalingGroupName;
        reqParams.cfn['PolicyType'] = obj.data.PolicyType;
        reqParams.tf['policy_type'] = obj.data.PolicyType;
        reqParams.cfn['AdjustmentType'] = obj.data.AdjustmentType;
        reqParams.tf['adjustment_type'] = obj.data.AdjustmentType;
        reqParams.cfn['MinAdjustmentMagnitude'] = obj.data.MinAdjustmentMagnitude;
        reqParams.tf['MinAdjustmentMagnitude'] = obj.data.MinAdjustmentMagnitude;
        reqParams.cfn['ScalingAdjustment'] = obj.data.ScalingAdjustment;
        reqParams.tf['scaling_adjustment'] = obj.data.ScalingAdjustment;
        reqParams.cfn['Cooldown'] = obj.data.Cooldown;
        reqParams.tf['cooldown'] = obj.data.Cooldown;
        reqParams.cfn['StepAdjustments'] = obj.data.StepAdjustments;
        // if (obj.data.StepAdjustments) {
        //     reqParams.tf['step_adjustments'] = [];
        //     obj.data.StepAdjustments.forEach(stepadjustment => {
        //         reqParams.tf['step_adjustments'].push({
        //             'metric_interval_lower_bound': stepadjustment.MetricIntervalLowerBound,
        //             'metric_interval_upper_bound': stepadjustment.MetricIntervalUpperBound,
        //             'scaling_adjustment': stepadjustment.ScalingAdjustment
        //         });
        //     });
        // }
        reqParams.cfn['MetricAggregationType'] = obj.data.MetricAggregationType;
        reqParams.tf['metric_aggregation_type'] = obj.data.MetricAggregationType;
        reqParams.cfn['EstimatedInstanceWarmup'] = obj.data.EstimatedInstanceWarmup;
        reqParams.tf['estimated_instance_warmup'] = obj.data.EstimatedInstanceWarmup;
        reqParams.cfn['TargetTrackingConfiguration'] = obj.data.TargetTrackingConfiguration;
        if (obj.data.TargetTrackingConfiguration) {
            var customizedmetricspecification = null;
            if (obj.data.TargetTrackingConfiguration.CustomizedMetricSpecification) {
                var dimensions = null;
                if (obj.data.TargetTrackingConfiguration.CustomizedMetricSpecification.Dimensions) {
                    dimensions = [];
                    obj.data.TargetTrackingConfiguration.CustomizedMetricSpecification.Dimensions.forEach(dimension => {
                        dimensions.push({
                            'name': dimension.Name,
                            'value': dimension.Value
                        });
                    });
                }
                customizedmetricspecification = {
                    'metric_dimension': dimensions,
                    'metric_name': obj.data.TargetTrackingConfiguration.CustomizedMetricSpecification.MetricName,
                    'namespace': obj.data.TargetTrackingConfiguration.CustomizedMetricSpecification.Namespace,
                    'statistic': obj.data.TargetTrackingConfiguration.CustomizedMetricSpecification.Statistic,
                    'unit': obj.data.TargetTrackingConfiguration.CustomizedMetricSpecification.Unit
                };
            }
            var predefinedmetricspecification = null;
            if (obj.data.TargetTrackingConfiguration.PredefinedMetricSpecification) {
                predefinedmetricspecification = {
                    'predefined_metric_type': obj.data.TargetTrackingConfiguration.PredefinedMetricSpecification.PredefinedMetricType,
                    'resource_label': obj.data.TargetTrackingConfiguration.PredefinedMetricSpecification.ResourceLabel
                };
            }
            reqParams.tf['target_tracking_configuration'] = {
                'customized_metric_specification': customizedmetricspecification,
                'disable_scale_in': obj.data.TargetTrackingConfiguration.DisableScaleIn,
                'predefined_metric_specification': predefinedmetricspecification,
                'target_value': obj.data.TargetTrackingConfiguration.TargetValue
            };
        }

        tracked_resources.push({
            'obj': obj,
            'logicalId': getResourceName('autoscaling', obj.id, 'AWS::AutoScaling::ScalingPolicy'),
            'region': obj.region,
            'service': 'autoscaling',
            'type': 'AWS::AutoScaling::ScalingPolicy',
            'terraformType': 'aws_autoscaling_policy',
            'options': reqParams,
            'returnValues': {
                'Ref': obj.data.PolicyARN,
                'Import': {
                    'PolicyName': obj.data.PolicyName
                }
            }
        });
    } else if (obj.type == "autoscaling.scheduledaction") {
        reqParams.cfn['AutoScalingGroupName'] = obj.data.AutoScalingGroupName;
        reqParams.tf['autoscaling_group_name'] = obj.data.AutoScalingGroupName;
        reqParams.tf['scheduled_action_name'] = obj.data.AutoScalingGroupName;
        reqParams.cfn['StartTime'] = obj.data.StartTime;
        // reqParams.tf['start_time'] = obj.data.StartTime;
        reqParams.cfn['EndTime'] = obj.data.EndTime;
        reqParams.tf['end_time'] = obj.data.EndTime;
        reqParams.cfn['Recurrence'] = obj.data.Recurrence;
        reqParams.tf['recurrence'] = obj.data.Recurrence;
        reqParams.cfn['MaxSize'] = obj.data.MaxSize;
        reqParams.tf['max_size'] = obj.data.MaxSize;
        reqParams.cfn['MinSize'] = obj.data.MinSize;
        reqParams.tf['min_size'] = obj.data.MinSize;
        reqParams.cfn['DesiredCapacity'] = obj.data.DesiredCapacity;
        reqParams.tf['desired_capacity'] = obj.data.DesiredCapacity;

        tracked_resources.push({
            'obj': obj,
            'logicalId': getResourceName('autoscaling', obj.id, 'AWS::AutoScaling::ScheduledAction'),
            'region': obj.region,
            'service': 'autoscaling',
            'type': 'AWS::AutoScaling::ScheduledAction',
            'terraformType': 'aws_autoscaling_schedule',
            'options': reqParams,
            'returnValues': {
                'Ref': obj.data.AutoScalingGroupName,
                'Import': {
                    'ScheduledActionName': obj.data.ScheduledActionName
                }
            }
        });
    } else if (obj.type == "autoscaling.autoscalinggroup") {
        reqParams.cfn['AutoScalingGroupName'] = obj.data.AutoScalingGroupName;
        reqParams.tf['name'] = obj.data.AutoScalingGroupName;
        reqParams.cfn['LaunchConfigurationName'] = obj.data.LaunchConfigurationName;
        reqParams.tf['launch_configuration'] = obj.data.LaunchConfigurationName;
        reqParams.cfn['LaunchTemplate'] = obj.data.LaunchTemplate;
        if (obj.data.LaunchTemplate) {
            
            reqParams.tf['launch_template'] = {
                'id': obj.data.LaunchTemplate.LaunchTemplateId,
                // 'name': obj.data.LaunchTemplate.LaunchTemplateName,
                'version': obj.data.LaunchTemplate.Version
            };
        }
        reqParams.cfn['MixedInstancesPolicy'] = obj.data.MixedInstancesPolicy;
        if (obj.data.MixedInstancesPolicy) {
            var instancesdistribution = null;
            if (obj.data.MixedInstancesPolicy.InstancesDistribution) {
                instancesdistribution = {
                    'on_demand_allocation_strategy': obj.data.MixedInstancesPolicy.InstancesDistribution.OnDemandAllocationStrategy,
                    'on_demand_base_capacity': obj.data.MixedInstancesPolicy.InstancesDistribution.OnDemandBaseCapacity,
                    'on_demand_percentage_above_base_capacity': obj.data.MixedInstancesPolicy.InstancesDistribution.OnDemandPercentageAboveBaseCapacity,
                    'spot_allocation_strategy': obj.data.MixedInstancesPolicy.InstancesDistribution.SpotAllocationStrategy,
                    'spot_instance_pools': obj.data.MixedInstancesPolicy.InstancesDistribution.SpotInstancePools,
                    'spot_max_price': obj.data.MixedInstancesPolicy.InstancesDistribution.SpotMaxPrice
                };
            }
            var override = [];
            obj.data.MixedInstancesPolicy.LaunchTemplate.Overrides.forEach(launchtemplateoverride => {
                override.push({
                    'instance_type': launchtemplateoverride.InstanceType
                });
            });
            reqParams.tf['mixed_instances_policy'] = {
                'instances_distribution': instancesdistribution,
                'launch_template': {
                    'launch_template_specification': {
                        'launch_template_id': obj.data.MixedInstancesPolicy.LaunchTemplate.LaunchTemplateSpecification.LaunchTemplateId,
                        'launch_template_name': obj.data.MixedInstancesPolicy.LaunchTemplate.LaunchTemplateSpecification.LaunchTemplateName,
                        'version': obj.data.MixedInstancesPolicy.LaunchTemplate.LaunchTemplateSpecification.Version
                    },
                    'override': override
                }
            };
        }
        reqParams.cfn['MinSize'] = obj.data.MinSize;
        reqParams.tf['min_size'] = obj.data.MinSize;
        reqParams.cfn['MaxSize'] = obj.data.MaxSize;
        reqParams.tf['max_size'] = obj.data.MaxSize;
        reqParams.cfn['DesiredCapacity'] = obj.data.DesiredCapacity;
        reqParams.tf['desired_capacity'] = obj.data.DesiredCapacity;
        reqParams.cfn['Cooldown'] = obj.data.DefaultCooldown;
        reqParams.tf['default_cooldown'] = obj.data.DefaultCooldown;
        reqParams.cfn['AvailabilityZones'] = obj.data.AvailabilityZones;
        reqParams.tf['availability_zones'] = obj.data.AvailabilityZones;
        reqParams.cfn['LoadBalancerNames'] = obj.data.LoadBalancerNames;
        reqParams.tf['load_balancers'] = obj.data.LoadBalancerNames;
        reqParams.cfn['TargetGroupARNs'] = obj.data.TargetGroupARNs;
        reqParams.tf['target_group_arns'] = obj.data.TargetGroupARNs;
        reqParams.cfn['HealthCheckType'] = obj.data.HealthCheckType;
        reqParams.tf['health_check_type'] = obj.data.HealthCheckType;
        reqParams.cfn['HealthCheckGracePeriod'] = obj.data.HealthCheckGracePeriod;
        reqParams.tf['health_check_grace_period'] = obj.data.HealthCheckGracePeriod;
        reqParams.cfn['PlacementGroup'] = obj.data.PlacementGroup;
        reqParams.tf['placement_group'] = obj.data.PlacementGroup;
        reqParams.cfn['VPCZoneIdentifier'] = obj.data.VPCZoneIdentifier.split(",");
        // reqParams.tf['vpc_zone_identifier'] = obj.data.VPCZoneIdentifier.split(",");
        reqParams.cfn['TerminationPolicies'] = obj.data.TerminationPolicies;
        reqParams.tf['termination_policies'] = obj.data.TerminationPolicies;
        reqParams.cfn['ServiceLinkedRoleARN'] = obj.data.ServiceLinkedRoleARN;
        reqParams.tf['service_linked_role_arn'] = obj.data.ServiceLinkedRoleARN;
        if (obj.data.EnabledMetrics && obj.data.EnabledMetrics[0] && obj.data.EnabledMetrics[0].Granularity) {
            reqParams.tf['metrics_granularity'] = obj.data.EnabledMetrics[0].Granularity;
            reqParams.tf['enabled_metrics'] = [];
            reqParams.cfn['MetricsCollection'] = {
                'Granularity': obj.data.EnabledMetrics[0].Granularity,
                'Metrics': []
            };
            obj.data.EnabledMetrics.forEach(metric => {
                reqParams.cfn.MetricsCollection.Metrics.push(metric.Metric);
                reqParams.tf['enabled_metrics'].push(metric.Metric);
            });
        }
        if (obj.data.Tags) {
            reqParams.cfn['Tags'] = [];
            reqParams.tf['tag'] = [];
            obj.data.Tags.forEach(tag => {
                reqParams.cfn['Tags'].push({
                    'Key': tag.Key,
                    'Value': tag.Value,
                    'PropagateAtLaunch': tag.PropagateAtLaunch
                });
                reqParams.tf['tag'].push({
                    'key': tag.Key,
                    'value': tag.Value,
                    'propagate_at_launch': tag.PropagateAtLaunch
                });
            });
        }
        reqParams.cfn['MaxInstanceLifetime'] = obj.data.MaxInstanceLifetime;
        reqParams.cfn['NewInstancesProtectedFromScaleIn'] = obj.data.NewInstancesProtectedFromScaleIn;
        reqParams.cfn['HealthCheckGracePeriod'] = obj.data.HealthCheckGracePeriod;
        reqParams.cfn['CapacityRebalance'] = obj.data.CapacityRebalance;

        /*
        TODO:
        InstanceId: String
        LifecycleHookSpecificationList: 
            - LifecycleHookSpecification
        NotificationConfigurations:
            - NotificationConfiguration
        */

        tracked_resources.push({
            'obj': obj,
            'logicalId': getResourceName('autoscaling', obj.id, 'AWS::AutoScaling::AutoScalingGroup'),
            'region': obj.region,
            'service': 'autoscaling',
            'type': 'AWS::AutoScaling::AutoScalingGroup',
            'terraformType': 'aws_autoscaling_group',
            'options': reqParams,
            'returnValues': {
                'Ref': obj.data.AutoScalingGroupName,
                'Import': {
                    'AutoScalingGroupName': obj.data.AutoScalingGroupName
                }
            }
        });
    } else if (obj.type == "autoscaling.launchconfiguration") {
       
        reqParams.cfn['LaunchConfigurationName'] = obj.data.LaunchConfigurationName;
        reqParams.tf['name'] = obj.data.LaunchConfigurationName;
        reqParams.cfn['ImageId'] = obj.data.ImageId;
        reqParams.tf['image_id'] = obj.data.ImageId;
        reqParams.cfn['KeyName'] = obj.data.KeyName;
        reqParams.tf['key_name'] = obj.data.KeyName;
        reqParams.cfn['SecurityGroups'] = obj.data.SecurityGroups;
        reqParams.tf['security_groups'] = obj.data.SecurityGroups;
        reqParams.cfn['ClassicLinkVPCId'] = obj.data.ClassicLinkVPCId;
        reqParams.tf['vpc_classic_link_id'] = obj.data.ClassicLinkVPCId;
        reqParams.cfn['ClassicLinkVPCSecurityGroups'] = obj.data.ClassicLinkVPCSecurityGroups;
        reqParams.tf['vpc_classic_link_security_groups'] = obj.data.ClassicLinkVPCSecurityGroups;
        reqParams.cfn['UserData'] = (obj.data.UserData != "") ? obj.data.UserData : null;
        reqParams.tf['user_data'] = (obj.data.UserData != "") ? obj.data.UserData : null;
        reqParams.cfn['InstanceType'] = obj.data.InstanceType;
        reqParams.tf['instance_type'] = obj.data.InstanceType;
        reqParams.cfn['KernelId'] = (obj.data.KernelId != "") ? obj.data.KernelId : null;
        reqParams.cfn['RamDiskId'] = (obj.data.RamdiskId != "") ? obj.data.RamdiskId : null;
        reqParams.cfn['BlockDeviceMappings'] = obj.data.BlockDeviceMappings;       
        //reqParams.tf['BlockDeviceMappings'] = obj.data.BlockDeviceMappings; TODO
        if (obj.data.InstanceMonitoring) {
            reqParams.cfn['InstanceMonitoring'] = obj.data.InstanceMonitoring.Enabled;
            reqParams.tf['enable_monitoring'] = obj.data.InstanceMonitoring.Enabled;
        }
        reqParams.cfn['SpotPrice'] = obj.data.SpotPrice;
        reqParams.tf['spot_price'] = obj.data.SpotPrice;
        reqParams.cfn['IamInstanceProfile'] = obj.data.IamInstanceProfile;
        reqParams.tf['iam_instance_profile'] = obj.data.IamInstanceProfile;
        reqParams.cfn['EbsOptimized'] = obj.data.EbsOptimized;
        reqParams.tf['ebs_optimized'] = obj.data.EbsOptimized;
        reqParams.cfn['AssociatePublicIpAddress'] = obj.data.AssociatePublicIpAddress;
        reqParams.tf['associate_public_ip_address'] = obj.data.AssociatePublicIpAddress;
        reqParams.cfn['PlacementTenancy'] = obj.data.PlacementTenancy;
        reqParams.tf['placement_tenancy'] = obj.data.PlacementTenancy;

        /*
        TODO:
        InstanceId: String
        */

        tracked_resources.push({
            'obj': obj,
            'logicalId': getResourceName('autoscaling', obj.id, 'AWS::AutoScaling::LaunchConfiguration'),
            'region': obj.region,
            'service': 'autoscaling',
            'type': 'AWS::AutoScaling::LaunchConfiguration',
            'terraformType': 'aws_launch_configuration',
            'options': reqParams,
            'returnValues': {
                'Ref': obj.data.LaunchConfigurationName,
                'Import': {
                    'LaunchConfigurationName': obj.data.LaunchConfigurationName
                }
            }
        });
    } else if (obj.type == "autoscaling.scalingplan") {
        reqParams.cfn['ApplicationSource'] = obj.data.ApplicationSource;
        reqParams.cfn['ScalingInstructions'] = [];
        obj.data.ScalingInstructions.forEach(scalingInstruction => {
            reqParams.cfn['ScalingInstructions'].push({
                'ServiceNamespace': scalingInstruction.ServiceNamespace,
                'ResourceId': scalingInstruction.ResourceId,
                'ScalableDimension': scalingInstruction.ScalableDimension,
                'MinCapacity': scalingInstruction.MinCapacity,
                'MaxCapacity': scalingInstruction.MaxCapacity,
                'TargetTrackingConfigurations': scalingInstruction.TargetTrackingConfigurations,
                'PredefinedLoadMetricSpecification': scalingInstruction.PredefinedLoadMetricSpecification,
                'CustomizedLoadMetricSpecification': scalingInstruction.CustomizedLoadMetricSpecification,
                'ScheduledActionBufferTime': scalingInstruction.ScheduledActionBufferTime,
                'PredictiveScalingMaxCapacityBehavior': scalingInstruction.PredictiveScalingMaxCapacityBehavior,
                'PredictiveScalingMaxCapacityBuffer': scalingInstruction.PredictiveScalingMaxCapacityBuffer,
                'PredictiveScalingMode': scalingInstruction.PredictiveScalingMode,
                'ScalingPolicyUpdateBehavior': scalingInstruction.ScalingPolicyUpdateBehavior,
                'DisableDynamicScaling': scalingInstruction.DisableDynamicScaling
            });
        });

        tracked_resources.push({
            'obj': obj,
            'logicalId': getResourceName('autoscaling', obj.id, 'AWS::AutoScalingPlans::ScalingPlan'),
            'region': obj.region,
            'service': 'autoscaling',
            'type': 'AWS::AutoScalingPlans::ScalingPlan',
            'options': reqParams
        });
    } else if (obj.type == "autoscaling.lifecyclehook") {
        reqParams.cfn['LifecycleHookName'] = obj.data.LifecycleHookName;
        reqParams.tf['name'] = obj.data.LifecycleHookName;
        reqParams.cfn['AutoScalingGroupName'] = obj.data.AutoScalingGroupName;
        reqParams.tf['autoscaling_group_name'] = obj.data.AutoScalingGroupName;
        reqParams.cfn['NotificationTargetARN'] = obj.data.NotificationTargetARN;
        reqParams.tf['notification_target_arn'] = obj.data.NotificationTargetARN;
        reqParams.cfn['NotificationMetadata'] = obj.data.NotificationMetadata;
        reqParams.tf['notification_metadata'] = obj.data.NotificationMetadata;
        reqParams.cfn['RoleARN'] = obj.data.RoleARN;
        reqParams.tf['role_arn'] = obj.data.RoleARN;
        reqParams.cfn['HeartbeatTimeout'] = obj.data.HeartbeatTimeout;
        reqParams.tf['heartbeat_timeout'] = obj.data.HeartbeatTimeout;
        reqParams.cfn['DefaultResult'] = obj.data.DefaultResult;
        reqParams.tf['default_result'] = obj.data.DefaultResult;
        reqParams.cfn['LifecycleTransition'] = obj.data.LifecycleTransition;
        reqParams.tf['lifecycle_transition'] = obj.data.LifecycleTransition;

        tracked_resources.push({
            'obj': obj,
            'logicalId': getResourceName('autoscaling', obj.id, 'AWS::AutoScaling::LifecycleHook'),
            'region': obj.region,
            'service': 'autoscaling',
            'type': 'AWS::AutoScaling::LifecycleHook',
            'terraformType': 'aws_autoscaling_lifecycle_hook',
            'options': reqParams,
            'returnValues': {
                'Import': {
                    'AutoScalingGroupName': obj.data.AutoScalingGroupName,
                    'LifecycleHookName': obj.data.LifecycleHookName
                }
            }
        });
    } else {
        return false;
    }

    return true;
});

