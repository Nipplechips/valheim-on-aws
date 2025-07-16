// Import AWS SDK modules at the top of the file
const { AutoScalingClient, DescribeAutoScalingGroupsCommand, SetDesiredCapacityCommand } = require('@aws-sdk/client-auto-scaling');
// Import AWS SDK EC2 client and command at the top of the file
const { EC2Client, DescribeInstancesCommand } = require('@aws-sdk/client-ec2');

const autoScaling = new AutoScalingClient();
const ec2 = new EC2Client();

exports.handler = async (event) => {
  const asgName = process.env.ASG_NAME;
  
  try {
    // Handle SNS alarm trigger for auto-shutdown
    if (event.Records && event.Records[0].Sns) {
      console.log('Auto-shutdown triggered by alarm');
      await autoScaling.send(new SetDesiredCapacityCommand({
        AutoScalingGroupName: asgName,
        DesiredCapacity: 0
      }));
      return { statusCode: 200, body: 'Auto-shutdown completed' };
    }
    
    const command = event.body ? JSON.parse(event.body).command : 'status';
    
    switch (command) {
      case 'start':
        await autoScaling.send(new SetDesiredCapacityCommand({
          AutoScalingGroupName: asgName,
          DesiredCapacity: 1,
          HonorCooldown: false
        }));
        return { statusCode: 200, body: 'Server starting... (may take 3-5 minutes)' };
        
      case 'stop':
        await autoScaling.send(new SetDesiredCapacityCommand({
          AutoScalingGroupName: asgName,
          DesiredCapacity: 0
        }));
        return { statusCode: 200, body: 'Server stopping...' };
        
      case 'status':
        const asgResponse = await autoScaling.send(new DescribeAutoScalingGroupsCommand({
          AutoScalingGroupNames: [asgName]
        }));
        
        const asg = asgResponse.AutoScalingGroups[0];
        const desiredCapacity = asg.DesiredCapacity;
        const instanceCount = asg.Instances.length;
        
        if (desiredCapacity === 0) {
          return { statusCode: 200, body: 'Server is stopped (0 instances)' };
        }
        
        if (instanceCount === 0) {
          return { statusCode: 200, body: 'Server is starting...' };
        }
        
        const instanceId = asg.Instances[0].InstanceId;
        const ec2Response = await ec2.send(new DescribeInstancesCommand({
          InstanceIds: [instanceId]
        }));
        
        const instance = ec2Response.Reservations[0].Instances[0];
        const state = instance.State.Name;
        const publicDns = instance.PublicDnsName || 'N/A';
        
        return { 
          statusCode: 200, 
          body: `Server ${state}. DNS: ${publicDns}` 
        };
        
      default:
        return { statusCode: 400, body: 'Invalid command' };
    }
  } catch (error) {
    console.error(error);
    return { statusCode: 500, body: 'Error processing request' };
  }
};