// ---------------------------
// 1. Imports and Environment Setup
// ---------------------------
const { EVM, utils } = require('signet.js');
const { KeyPair } = require('@near-js/crypto');
const { TwitterApi } = require('twitter-api-v2');
const { connect, keyStores, Contract } = require('near-api-js');
const { ethers } = require('ethers');
const { Configuration, OpenAIApi } = require('openai');
const crypto = require('crypto');
const process = require('process');

// Ensure required credentials are present
const accountId = process.env.NEAR_ACCOUNT_ID;
const privateKey = process.env.NEAR_PRIVATE_KEY;
const BOT_USERNAME = '@betbot';

if (!accountId || !privateKey) {
  throw new Error('NEAR_ACCOUNT_ID and NEAR_PRIVATE_KEY must be set in environment');
}

const keypair = KeyPair.fromString(privateKey);

// OpenAI configuration
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

// ---------------------------
// 2. Initialize Chain Signature Contract and Base Client
// ---------------------------
const chainSignatureContract = new utils.chains.near.ChainSignatureContract({
  networkId: 'testnet',
  contractId: 'v1.signer-prod.testnet',
  accountId,
  keypair,
});

const baseChain = new EVM({
  rpcUrl: 'https://base.rpc.url',
  contract: chainSignatureContract,
});

// ---------------------------
// 3. Initialize Twitter API Client
// ---------------------------
const twitterClient = new TwitterApi({
  appKey: 'YOUR_TWITTER_APP_KEY',
  appSecret: 'YOUR_TWITTER_APP_SECRET',
  accessToken: 'YOUR_TWITTER_ACCESS_TOKEN',
  accessSecret: 'YOUR_TWITTER_ACCESS_SECRET',
});

async function postTweet(text, options = {}) {
  try {
    const { data } = await twitterClient.v2.tweet(text, options);
    console.log(`[TWITTER] Tweet posted: ${data.id}`);
    return data.id;
  } catch (err) {
    console.error('[TWITTER] Error posting tweet:', err);
  }
}

// ---------------------------
// 4. Initialize NEAR Client
// ---------------------------
const nearConfig = {
  networkId: 'testnet',
  nodeUrl: 'https://rpc.testnet.near.org',
  walletUrl: 'https://wallet.testnet.near.org',
  helperUrl: 'https://helper.testnet.near.org',
  contractName: 'betting_contract.testnet',
};

const keyStore = new keyStores.InMemoryKeyStore();

async function initNear() {
  const near = await connect({ deps: { keyStore }, ...nearConfig });
  const account = await near.account('your-account.testnet');
  const contract = new Contract(account, nearConfig.contractName, {
    viewMethods: ['get_all_bets', 'get_bets_by_status', 'get_bets_by_status_age'],
    changeMethods: ['new_bet', 'update_bet_state'],
  });
  return { near, account, contract };
}

// ---------------------------
// 5. Utility Functions
// ---------------------------
function generateDerivationPath() {
  return `base_${crypto.randomBytes(16).toString('hex')}`;
}

// ---------------------------
// 6. OpenAI Integration Functions
// ---------------------------
async function parseBetDetails(tweetText) {
  const prompt = `
    Parse the following tweet for betting details. Extract:
    1. Bet amount (in USDC)
    2. Initial resolution criteria
    3. Challenged Twitter account
    4. Challenger's Twitter account
    5. Deadline (in hours from now)

    Tweet: ${tweetText}

    Return as JSON format.
  `;

  try {
    const completion = await openai.createChatCompletion({
      model: "gpt-4",
      messages: [
        { role: "system", content: "You are a precise bet detail parser. Extract only the requested information and return it in JSON format." },
        { role: "user", content: prompt }
      ]
    });

    return JSON.parse(completion.data.choices[0].message.content);
  } catch (error) {
    console.error('[OPENAI] Error parsing bet details:', error);
    return null;
  }
}

async function generateResolutionCriteria(initialCriteria) {
  const prompt = `
    Create detailed, unambiguous resolution criteria for the following bet:
    "${initialCriteria}"

    Include:
    1. Exact conditions for winning/losing
    2. Data sources to be used
    3. Specific timing requirements
    4. How edge cases should be handled
    5. Any additional clarifications needed

    Format it similar to Polymarket's detailed market resolution criteria.
  `;

  try {
    const completion = await openai.createChatCompletion({
      model: "gpt-4",
      messages: [
        { role: "system", content: "You are an expert at creating unambiguous betting market resolution criteria." },
        { role: "user", content: prompt }
      ]
    });

    return completion.data.choices[0].message.content;
  } catch (error) {
    console.error('[OPENAI] Error generating resolution criteria:', error);
    return null;
  }
}

// ---------------------------
// 7. Base Chain Functions
// ---------------------------
async function deriveDepositAddress(signerId, derivationPath) {
  try {
    const { address, publicKey } = await baseChain.deriveAddressAndPublicKey(signerId, derivationPath);
    console.log(`[BASE] Derived deposit address: ${address}`);
    return { address, publicKey };
  } catch (err) {
    console.error('[BASE] Error deriving deposit address:', err);
    throw err;
  }
}

async function checkDepositBalance(address) {
  try {
    const balance = await baseChain.getBalance(address);
    console.log(`[BASE] Balance for ${address}: ${balance}`);
    return balance;
  } catch (err) {
    console.error('[BASE] Error checking deposit balance:', err);
    return "0";
  }
}

async function processTransaction(from, recipient, usdcAmount, derivationPath) {
  const usdcContractAddress = '0xUSDC_ADDRESS_ON_BASE';
  const USDC_ABI = [
    'function transfer(address to, uint256 amount) public returns (bool)',
  ];
  
  const iface = new ethers.utils.Interface(USDC_ABI);
  const data = iface.encodeFunctionData('transfer', [recipient, usdcAmount]);

  const transactionRequest = {
    to: usdcContractAddress,
    from,
    value: '0',
    data,
  };

  try {
    const { transaction, mpcPayloads } = await baseChain.getMPCPayloadAndTransaction(transactionRequest);
    const signature = await baseChain.contract.sign({
      payload: mpcPayloads[0].payload,
      path: derivationPath,
      key_version: 0,
    });

    const signedTx = await baseChain.addSignature({
      transaction,
      mpcSignatures: [signature],
    });

    const txHash = await baseChain.broadcastTx(signedTx);
    console.log(`[BASE] USDC Transaction broadcasted: ${txHash}`);
    return txHash;
  } catch (err) {
    console.error('[BASE] Error processing USDC transaction:', err);
    throw err;
  }
}

// ---------------------------
// 8. Twitter Mention Processing
// ---------------------------
async function processTweetMention(tweet, contract) {
  try {
    if (!tweet.text.includes(BOT_USERNAME)) return;

    console.log(`[TWITTER] Processing mention: ${tweet.text}`);

    const betDetails = await parseBetDetails(tweet.text);
    if (!betDetails) {
      await postTweet(`@${tweet.author.username} Sorry, I couldn't parse your bet details. Please try again with a clearer format.`);
      return;
    }

    const detailedCriteria = await generateResolutionCriteria(betDetails.initialCriteria);
    if (!detailedCriteria) {
      await postTweet(`@${tweet.author.username} Sorry, I couldn't generate resolution criteria. Please try again.`);
      return;
    }

    const participant1Path = generateDerivationPath();
    const participant2Path = generateDerivationPath();

    try {
      const bet_id = await contract.new_bet({
        participant1_deposit_path: participant1Path,
        participant2_deposit_path: participant2Path,
        amount: ethers.utils.parseUnits(betDetails.amount.toString(), 6).toString(),
        resolution_criteria: detailedCriteria
      });

      const { address: address1 } = await deriveDepositAddress(tweet.author.username, participant1Path);
      const { address: address2 } = await deriveDepositAddress(betDetails.challengedAccount, participant2Path);

      const initialTweet = await postTweet(`
@${tweet.author.username} @${betDetails.challengedAccount} Bet created! (ID: ${bet_id})

Challenger deposit address:
${address1}

Challenged deposit address:
${address2}

Amount: ${betDetails.amount} USDC
Deadline: ${betDetails.deadline}h

Full resolution criteria in thread...`);

      const criteriaTweets = detailedCriteria.match(/.{1,280}/g) || [];
      for (const criteriaPart of criteriaTweets) {
        await postTweet(criteriaPart, { reply: { in_reply_to_tweet_id: initialTweet }});
      }

    } catch (error) {
      console.error('[NEAR] Error creating bet:', error);
      await postTweet(`@${tweet.author.username} Sorry, there was an error creating your bet. Please try again.`);
    }
  } catch (error) {
    console.error('[WORKER] Error processing tweet mention:', error);
  }
}

// ---------------------------
// 9. Main Worker Loop
// ---------------------------
async function main() {
  const { contract } = await initNear();

  // Set up Twitter stream for mentions
  const stream = await twitterClient.v2.searchStream({
    'tweet.fields': ['author_id', 'created_at', 'referenced_tweets'],
    'expansions': ['author_id', 'referenced_tweets.id'],
  });

  stream.on('data', async tweet => {
    await processTweetMention(tweet, contract);
  });

  // Poll for bet status updates
  setInterval(async () => {
    try {
      // Check for unfunded bets
      const unfundedBets = await contract.get_bets_by_status({ status: 'Unfunded' });
      for (const bet of unfundedBets) {
        const balance1 = await checkDepositBalance(bet.participant1_deposit_path);
        const balance2 = await checkDepositBalance(bet.participant2_deposit_path);
        
        // Track which participants have funded
        const participant1Funded = parseFloat(balance1) > 0;
        const participant2Funded = parseFloat(balance2) > 0;

        if (participant1Funded && participant2Funded) {
          // Both participants have funded
          await contract.update_bet_state({
            bet_id: bet.id,
            new_status: 'Live'
          });
          console.log(`[NEAR] Bet ${bet.id} is now fully funded and active.`);
          await postTweet(`🎉 Bet #${bet.id} is fully funded! Both players have deposited their USDC. The bet is now live and will be resolved according to the specified criteria. Good luck to both participants! 🤝`);
        } else if (participant1Funded || participant2Funded) {
          // One participant has funded - post update but don't change status
          const fundedParticipant = participant1Funded ? "Challenger" : "Challenged player";
          await postTweet(`Update on Bet #${bet.id}: ${fundedParticipant} has funded their position. Waiting for the other player to complete funding. ⏳`);
        }
      }

      // Check for live bets
      const liveBets = await contract.get_bets_by_status({ status: 'Live' });
      
      for (const bet of liveBets) {
        const currentTime = Date.now();
        const deadline = new Date(bet.created_at / 1e6).getTime() + (bet.deadline_hours * 60 * 60 * 1000);
        
        if (currentTime >= deadline) {
          console.log(`[WORKER] Bet ${bet.id} has reached deadline, determining outcome...`);
          
          try {
            // Query Perplexity API to determine outcome
            const response = await fetch('https://api.perplexity.ai/chat/completions', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                model: 'pplx-7b-chat',
                messages: [{
                  role: 'system',
                  content: 'You are an impartial betting outcome resolver. Based on the resolution criteria and the available information, determine if the bet should be marked as won by participant 1, won by participant 2, or inconclusive. Return ONLY "PARTICIPANT1_WIN", "PARTICIPANT2_WIN", or "INCONCLUSIVE".'
                }, {
                  role: 'user',
                  content: `Resolution criteria: ${bet.resolution_criteria}\n\nPlease determine the outcome based on publicly available information.`
                }]
              })
            });

            const result = await response.json();
            const outcome = result.choices[0].message.content.trim();

            if (outcome === 'INCONCLUSIVE') {
              await contract.update_bet_state({
                bet_id: bet.id,
                new_status: 'Inconclusive'
              });
              
              await postTweet(`Bet #${bet.id} outcome is inconclusive based on the resolution criteria. The bet will be refunded to both participants.`);
              
              // Process refunds here
              const txHash1 = await processTransaction(
                bet.participant1_deposit_path,
                bet.participant1_deposit_path,
                bet.amount,
                `base_${bet.id}_refund1`
              );
              
              const txHash2 = await processTransaction(
                bet.participant2_deposit_path,
                bet.participant2_deposit_path,
                bet.amount,
                `base_${bet.id}_refund2`
              );

              await postTweet(`Bet #${bet.id} refunds processed. Tx hashes: ${txHash1}, ${txHash2}`);
            } else {
              // Determine winner address based on outcome
              const winnerPath = outcome === 'PARTICIPANT1_WIN' ? 
                bet.participant1_deposit_path : 
                bet.participant2_deposit_path;
              
              // Transfer full bet amount to winner
              const totalAmount = ethers.BigNumber.from(bet.amount).mul(2);
              const txHash = await processTransaction(
                bet.participant1_deposit_path, // Use participant1's address as source
                winnerPath,
                totalAmount.toString(),
                `base_${bet.id}_payout`
              );

              await contract.update_bet_state({
                bet_id: bet.id,
                new_status: 'Resolved'
              });

              const winnerNumber = outcome === 'PARTICIPANT1_WIN' ? '1' : '2';
              await postTweet(`Bet #${bet.id} has been resolved! Participant ${winnerNumber} wins! Payout tx: ${txHash}`);
            }
          } catch (error) {
            console.error(`[PERPLEXITY] Error resolving bet ${bet.id}:`, error);
            // Don't change bet status on error, will retry next cycle
          }
        } else {
          console.log(`[WORKER] Bet ${bet.id} deadline not yet reached. Continuing...`);
        }
      }
    } catch (err) {
      console.error('[WORKER] Error in main loop:', err);
    }
  }, 30000);
}

main().catch(err => console.error('[WORKER] Fatal error:', err));