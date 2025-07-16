import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { InteractionResponseType, InteractionType, verifyKey } from 'discord-interactions';
import { AutoScalingClient, DescribeAutoScalingGroupsCommand, DescribePoliciesCommand, SetDesiredCapacityCommand } from "@aws-sdk/client-auto-scaling";
import { DescribeInstancesCommand, EC2Client } from '@aws-sdk/client-ec2';

const publicKey = process.env.DISCORD_APP_PUBLIC_KEY!;
const asgName = process.env.ASG_NAME!;

const ec2 = new EC2Client({});
const autoscalingClient = new AutoScalingClient({});

export const discordHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const signature = event.headers['x-signature-ed25519'];
    const timestamp = event.headers['x-signature-timestamp'];
    const body = event.body!;

    if(!signature){
      throw new Error('Missing signature');
    }
    if(!timestamp){
      throw new Error('Missing timestamp');
    }

    if (!verifyKey(body, signature, timestamp, publicKey)) {
      return { statusCode: 401, body: 'Unauthorized' };
    }

    const interaction = JSON.parse(body);
    console.log("interaction", interaction)

    // Handle ping
    if (interaction.type === InteractionType.PING) {
      return {
        statusCode: 200,
        body: JSON.stringify({ type: InteractionResponseType.PONG })
      };
    }

    // Handle slash commands
    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
      const command = interaction.data.name;
      
      switch (command) {
        case 'start':
          await setASGCapacity(1);
          return discordResponse('🚀 Starting Valheim server...');
        
        case 'stop':
          await setASGCapacity(0);
          return discordResponse('🛑 Stopping Valheim server...');
        
        case 'status':
          const status = await getServerStatus();
          return discordResponse(status);
        
        default:
          return discordResponse('❌ Unknown command');
      }
    }

    return { statusCode: 400, body: 'Bad Request' };
  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, body: 'Internal Server Error' };
  }
};

const setASGCapacity = async (capacity: number): Promise<void> => {
  await autoscalingClient.send(new SetDesiredCapacityCommand({
    AutoScalingGroupName: asgName,
    DesiredCapacity: capacity,
    HonorCooldown: false
  }));
};

const getServerStatus = async (): Promise<string> => {
  const asgData = await autoscalingClient.send(new DescribeAutoScalingGroupsCommand({
    AutoScalingGroupNames: [asgName]
  }));

  const asg = asgData.AutoScalingGroups?.[0];
  if (!asg) return '❌ ASG not found';

  const desired = asg.DesiredCapacity || 0;
  const running = asg.Instances?.filter(i => i.LifecycleState === 'InService').length || 0;

  if (desired === 0) {
    return '🔴 Server is stopped';
  }

  if (running === 0) {
    return '🟡 Server is starting up...';
  }

  // Get instance details
  const instanceId = asg.Instances?.[0]?.InstanceId;
  if (instanceId) {
    const ec2Data = await ec2.send(new DescribeInstancesCommand({
      InstanceIds: [instanceId]
    }));
    
    const instance = ec2Data.Reservations?.[0]?.Instances?.[0];
    const publicIp = instance?.PublicIpAddress;
    
    return `🟢 Server is running${publicIp ? ` at ${publicIp}:2456` : ''}`;
  }

  return '🟢 Server is running';
};

const discordResponse = (content: string): APIGatewayProxyResult => ({
  statusCode: 200,
  body: JSON.stringify({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content }
  })
});