/** Create only the Base Probe cleanup Major proposal; no route change, stake, execute or broadcast. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, mainnet } from "viem/chains";
import {
  ACTION_FEE_BUDGET, BASE_CHAIN_KEY, BASE_EXECUTOR, BASE_PROBE, BROADCASTER, BSC_CHAIN_KEY,
  GOVERNANCE, LZ_GAS, MAJOR, MAJOR_PROPOSAL_FEE, OWNER, REGISTRY, broadcasterAbi,
  governanceAbi, executorAbi, registryAbi,
} from "./lib/cross-chain-message-fee-canary.js";
import {
  BASE_PROBE_CLEANUP_DESCRIPTION, buildBaseProbeCleanupBroadcastCalldata,
  buildBaseProbeCleanupInnerCalldata, buildBaseProbeCleanupProposalCalldata,
} from "./lib/base-probe-cleanup.js";

const CONFIRM = "MINT_APPROVE_CREATE_EXACT_BASE_PROBE_CLEANUP";
const STATE_FILE = "deployments/base-probe-cleanup-proposal.json";
const tokenAbi = parseAbi([
  "function MINTER_ROLE() view returns(bytes32)", "function hasRole(bytes32,address) view returns(bool)", "function paused() view returns(bool)",
  "function totalSupply() view returns(uint256)", "function balanceOf(address) view returns(uint256)", "function allowance(address,address) view returns(uint256)",
  "function mint(address,uint256)", "function approve(address,uint256) returns(bool)",
]);
type TxRecord = { hash: Hex; nonce: number; blockNumber: string; gasUsed: string; verified: true };
type State = { schemaVersion: 1; stage: "started" | "fee-minted" | "fee-approved" | "proposal-created"; startedAt: string; updatedAt: string;
  proposalCountBefore: string; expectedProposalId: string; dc: Address; treasury: Address; totalSupplyBefore: string; treasuryBalanceBefore: string;
  broadcastNonceBefore: string; innerCalldata: Hex; broadcastCalldata: Hex; createProposalCalldata: Hex;
  transactions: { mint?: TxRecord; approve?: TxRecord; createProposal?: TxRecord }; verification?: Record<string, unknown> };
function loadEnv(){if(!existsSync(".env"))return;for(const line of readFileSync(".env","utf8").split(/\r?\n/)){const m=line.match(/^([^#=]+)=(.*)$/);if(m&&!process.env[m[1].trim()])process.env[m[1].trim()]=m[2].trim();}}
function key():Hex{const raw=process.env.ETH_MAINNET_PRIVATE_KEY?.trim()||process.env.AGIKING_PRIVATE_KEY?.trim();if(!raw)throw new Error("Missing signing key");return(raw.startsWith("0x")?raw:`0x${raw}`)as Hex;}
function same(a:unknown,b:unknown){return String(a).toLowerCase()===String(b).toLowerCase();}
function assertThat(v:unknown,m:string):asserts v{if(!v)throw new Error(m);}
function stringify(v:unknown){return JSON.stringify(v,(_,x)=>typeof x==="bigint"?x.toString():x,2);}
function save(s:State){s.updatedAt=new Date().toISOString();writeFileSync(STATE_FILE,`${stringify(s)}\n`,`utf8`);}
async function waitExact(c:any,h:Hex,t:Address,d:Hex):Promise<TxRecord>{const r=await c.waitForTransactionReceipt({hash:h,confirmations:2,timeout:300_000});const tx=await c.getTransaction({hash:h});assertThat(r.status==="success"&&same(tx.from,OWNER)&&tx.to&&same(tx.to,t)&&tx.value===0n&&same(tx.input,d),`transaction mismatch: ${h}`);return{hash:h,nonce:tx.nonce,blockNumber:r.blockNumber.toString(),gasUsed:r.gasUsed.toString(),verified:true};}
async function main(){
  loadEnv();const mode=process.argv[2]||"preflight";assertThat(mode==="preflight"||mode==="execute","bad mode");
  if(existsSync(STATE_FILE)){const x=JSON.parse(readFileSync(STATE_FILE,"utf8"));if(x.stage==="proposal-created"){console.log(stringify({status:"PASS_ALREADY_CREATED",stateFile:STATE_FILE,...x.verification}));return;}throw new Error("partial state exists");}
  const rpc=process.env.ETH_MAINNET_RPC_URL?.trim()||"https://eth-mainnet.public.blastapi.io",baseRpc=process.env.BASE_MAINNET_RPC_URL?.trim()||"https://base-mainnet.public.blastapi.io";
  const e:any=createPublicClient({chain:mainnet,transport:http(rpc,{timeout:30000})}),a:any=createPublicClient({chain:base,transport:http(baseRpc,{timeout:30000})});
  assertThat(await e.getChainId()===1&&await a.getChainId()===8453,"RPC mismatch");
  const inner=buildBaseProbeCleanupInnerCalldata(),outer=buildBaseProbeCleanupBroadcastCalldata(),createData=buildBaseProbeCleanupProposalCalldata();
  const dc=getAddress(await e.readContract({address:GOVERNANCE,abi:governanceAbi,functionName:"dcToken"})),treasury=getAddress(await e.readContract({address:GOVERNANCE,abi:governanceAbi,functionName:"treasury"}));
  const minter=await e.readContract({address:dc,abi:tokenAbi,functionName:"MINTER_ROLE"});
  const[count,fee,canMint,paused,balance,allowance,supply,treasuryBalance,allowed,nonce,bscRoute,baseRoute,latest,pending,baseOwner,selfAllowed,probeAllowed]=await Promise.all([
    e.readContract({address:GOVERNANCE,abi:governanceAbi,functionName:"proposalCount"}),e.readContract({address:GOVERNANCE,abi:governanceAbi,functionName:"majorProposalFee"}),
    e.readContract({address:dc,abi:tokenAbi,functionName:"hasRole",args:[minter,OWNER]}),e.readContract({address:dc,abi:tokenAbi,functionName:"paused"}),e.readContract({address:dc,abi:tokenAbi,functionName:"balanceOf",args:[OWNER]}),e.readContract({address:dc,abi:tokenAbi,functionName:"allowance",args:[OWNER,GOVERNANCE]}),
    e.readContract({address:dc,abi:tokenAbi,functionName:"totalSupply"}),e.readContract({address:dc,abi:tokenAbi,functionName:"balanceOf",args:[treasury]}),
    e.readContract({address:REGISTRY,abi:registryAbi,functionName:"isActionAllowed",args:[MAJOR,BROADCASTER,ACTION_FEE_BUDGET,outer]}),e.readContract({address:BROADCASTER,abi:broadcasterAbi,functionName:"broadcastNonce"}),
    e.readContract({address:BROADCASTER,abi:broadcasterAbi,functionName:"chains",args:[BSC_CHAIN_KEY]}),e.readContract({address:BROADCASTER,abi:broadcasterAbi,functionName:"chains",args:[BASE_CHAIN_KEY]}),
    e.getTransactionCount({address:OWNER,blockTag:"latest"}),e.getTransactionCount({address:OWNER,blockTag:"pending"}),a.readContract({address:BASE_EXECUTOR,abi:executorAbi,functionName:"owner"}),
    a.readContract({address:BASE_EXECUTOR,abi:executorAbi,functionName:"allowedTargets",args:[BASE_EXECUTOR]}),a.readContract({address:BASE_EXECUTOR,abi:executorAbi,functionName:"allowedTargets",args:[BASE_PROBE]}),
  ]);
  assertThat(count===26n,"expected proposal #27");assertThat(fee===MAJOR_PROPOSAL_FEE&&canMint&&!paused&&balance===0n&&allowance===0n,"fee prerequisites failed");
  assertThat(allowed,"nested Base cleanup action blocked");assertThat(nonce===5n,"unexpected broadcast nonce");assertThat(bscRoute[6]&&baseRoute[6],"both routes must remain active at creation");
  assertThat(same(baseOwner,BASE_EXECUTOR)&&selfAllowed&&probeAllowed,"Base Executor cleanup prerequisite mismatch");assertThat(latest===pending,"pending ETH transaction");
  // With both routes active, the Base-only action must not be executable yet.
  let blocked=false;try{await e.readContract({address:BROADCASTER,abi:broadcasterAbi,functionName:"quoteFees",args:[[BASE_CHAIN_KEY],[BASE_EXECUTOR],inner,LZ_GAS]});}catch{blocked=true;}assertThat(blocked,"Base-only action unexpectedly executable before BSC route isolation");
  console.log(stringify({status:"PASS",mode,proposalCount:count,expectedProposalId:27,description:BASE_PROBE_CLEANUP_DESCRIPTION,actionAllowed:allowed,bothRoutesActive:true,executionIntentionallyBlockedUntilBscIsolation:blocked,noRouteChangeStakeExecutionOrBroadcast:true}));
  if(mode==="preflight")return;assertThat(process.env.BASE_PROBE_CLEANUP_PROPOSAL_CONFIRM===CONFIRM,"write gate closed");
  const account=privateKeyToAccount(key());assertThat(same(account.address,OWNER),"signer mismatch");const w:any=createWalletClient({account,chain:mainnet,transport:http(rpc,{timeout:30000})});
  const s:State={schemaVersion:1,stage:"started",startedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),proposalCountBefore:count.toString(),expectedProposalId:"27",dc,treasury,totalSupplyBefore:supply.toString(),treasuryBalanceBefore:treasuryBalance.toString(),broadcastNonceBefore:nonce.toString(),innerCalldata:inner,broadcastCalldata:outer,createProposalCalldata:createData,transactions:{}};save(s);
  const md=encodeFunctionData({abi:tokenAbi,functionName:"mint",args:[OWNER,MAJOR_PROPOSAL_FEE]});s.transactions.mint=await waitExact(e,await w.writeContract({address:dc,abi:tokenAbi,functionName:"mint",args:[OWNER,MAJOR_PROPOSAL_FEE]}),dc,md);s.stage="fee-minted";save(s);
  const ad=encodeFunctionData({abi:tokenAbi,functionName:"approve",args:[GOVERNANCE,MAJOR_PROPOSAL_FEE]});s.transactions.approve=await waitExact(e,await w.writeContract({address:dc,abi:tokenAbi,functionName:"approve",args:[GOVERNANCE,MAJOR_PROPOSAL_FEE]}),dc,ad);s.stage="fee-approved";save(s);
  const args=[[BROADCASTER],[ACTION_FEE_BUDGET],[outer],BASE_PROBE_CLEANUP_DESCRIPTION,MAJOR]as const;const sim=await e.simulateContract({account:OWNER,address:GOVERNANCE,abi:governanceAbi,functionName:"createProposal",args});assertThat(sim.result===27n,"simulated id mismatch");
  s.transactions.createProposal=await waitExact(e,await w.writeContract({address:GOVERNANCE,abi:governanceAbi,functionName:"createProposal",args}),GOVERNANCE,createData);
  const[pstate,p,acts,finalBalance,finalAllowance,finalSupply,finalTreasury,finalNonce,finalBscRoute,finalBaseRoute,finalProbeAllowed]=await Promise.all([
    e.readContract({address:GOVERNANCE,abi:governanceAbi,functionName:"state",args:[27n]}),e.readContract({address:GOVERNANCE,abi:governanceAbi,functionName:"getProposal",args:[27n]}),e.readContract({address:GOVERNANCE,abi:governanceAbi,functionName:"getActions",args:[27n]}),
    e.readContract({address:dc,abi:tokenAbi,functionName:"balanceOf",args:[OWNER]}),e.readContract({address:dc,abi:tokenAbi,functionName:"allowance",args:[OWNER,GOVERNANCE]}),e.readContract({address:dc,abi:tokenAbi,functionName:"totalSupply"}),e.readContract({address:dc,abi:tokenAbi,functionName:"balanceOf",args:[treasury]}),
    e.readContract({address:BROADCASTER,abi:broadcasterAbi,functionName:"broadcastNonce"}),e.readContract({address:BROADCASTER,abi:broadcasterAbi,functionName:"chains",args:[BSC_CHAIN_KEY]}),e.readContract({address:BROADCASTER,abi:broadcasterAbi,functionName:"chains",args:[BASE_CHAIN_KEY]}),a.readContract({address:BASE_EXECUTOR,abi:executorAbi,functionName:"allowedTargets",args:[BASE_PROBE]}),]);
  assertThat(pstate===1&&p.totalStaked===0n&&!p.executed&&p.description===BASE_PROBE_CLEANUP_DESCRIPTION,"proposal state mismatch");assertThat(acts[0].length===1&&same(acts[0][0],BROADCASTER)&&acts[1][0]===ACTION_FEE_BUDGET&&same(acts[2][0],outer),"action mismatch");
  assertThat(finalBalance===0n&&finalAllowance===0n&&finalSupply===supply+MAJOR_PROPOSAL_FEE&&finalTreasury===treasuryBalance+MAJOR_PROPOSAL_FEE,"fee accounting mismatch");assertThat(finalNonce===nonce&&finalBscRoute[6]&&finalBaseRoute[6]&&finalProbeAllowed,"creation caused route/broadcast/destination mutation");
  s.stage="proposal-created";s.verification={proposalId:27,proposalState:pstate,totalStaked:p.totalStaked,description:p.description,feeMovedToTreasury:MAJOR_PROPOSAL_FEE,bothRoutesStillActive:true,baseProbeStillAllowed:true,noStake:true,noExecution:true,noBroadcast:true};save(s);console.log(stringify({status:"PASS",stateFile:STATE_FILE,transactions:s.transactions,verification:s.verification}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
