use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::{
    env, near_bindgen, BorshStorageKey, PanicOnDefault, Timestamp,
};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::json_types::U128;
use near_sdk::collections::UnorderedMap;

#[derive(BorshSerialize, BorshStorageKey)]
enum StorageKey {
    Bets,
}

#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, PartialEq, Debug, Clone)]
#[serde(crate = "near_sdk::serde")]
pub enum BetStatus {
    Unfunded,
    Live,
    Resolved,
    Inconclusive,
}

#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct StatusChange {
    pub status: BetStatus,
    pub timestamp: Timestamp,
}

#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Bet {
    pub id: u64,
    pub participant1_deposit_path: String,
    pub participant2_deposit_path: String,
    pub amount: U128,
    pub status: BetStatus,
    pub created_at: Timestamp,
    pub last_status_change: Timestamp,
    pub status_history: Vec<StatusChange>,
    pub resolution_criteria: String,
}

#[near_bindgen]
#[derive(BorshDeserialize, BorshSerialize, PanicOnDefault)]
pub struct BettingContract {
    bets: UnorderedMap<u64, Bet>,
    next_bet_id: u64,
}

#[near_bindgen]
impl BettingContract {
    #[init]
    pub fn new() -> Self {
        Self {
            bets: UnorderedMap::new(StorageKey::Bets),
            next_bet_id: 0,
        }
    }

    #[payable]
    pub fn new_bet(
        &mut self,
        participant1_deposit_path: String,
        participant2_deposit_path: String,
        amount: U128,
        resolution_criteria: String,
    ) -> u64 {
        let bet_id = self.next_bet_id;
        self.next_bet_id += 1;
        
        let current_time = env::block_timestamp();
        let initial_status = StatusChange {
            status: BetStatus::Unfunded,
            timestamp: current_time,
        };

        let bet = Bet {
            id: bet_id,
            participant1_deposit_path,
            participant2_deposit_path,
            amount,
            status: BetStatus::Unfunded,
            created_at: current_time,
            last_status_change: current_time,
            status_history: vec![initial_status],
            resolution_criteria,
        };
        self.bets.insert(&bet_id, &bet);
        env::log_str(&format!("New bet created with id {}", bet_id));
        bet_id
    }

    pub fn update_bet_state(&mut self, bet_id: u64, new_status: BetStatus) {
        let mut bet = self.bets.get(&bet_id).expect("Bet not found");
        let current_time = env::block_timestamp();
        
        // Only update if status is actually changing
        if bet.status != new_status {
            bet.status = new_status.clone();
            bet.last_status_change = current_time;
            bet.status_history.push(StatusChange {
                status: new_status,
                timestamp: current_time,
            });
            self.bets.insert(&bet_id, &bet);
            env::log_str(&format!("Bet {} updated to status {:?}", bet_id, bet.status));
        }
    }

    pub fn get_bet(&self, bet_id: u64) -> Option<Bet> {
        self.bets.get(&bet_id)
    }

    pub fn get_all_bets(&self) -> Vec<Bet> {
        self.bets.values().collect()
    }

    /// Returns all bets with the specified status
    pub fn get_bets_by_status(&self, status: BetStatus) -> Vec<Bet> {
        self.bets
            .values()
            .filter(|bet| bet.status == status)
            .collect()
    }

    /// Returns all bets that have been in their current status for longer than the specified duration
    /// Duration is specified in nanoseconds
    pub fn get_bets_by_status_age(&self, status: BetStatus, min_age_ns: u64) -> Vec<Bet> {
        let current_time = env::block_timestamp();
        self.bets
            .values()
            .filter(|bet| {
                bet.status == status && 
                current_time.saturating_sub(bet.last_status_change) >= min_age_ns
            })
            .collect()
    }

    /// Returns the complete status change history for a bet
    pub fn get_bet_status_history(&self, bet_id: u64) -> Option<Vec<StatusChange>> {
        self.bets.get(&bet_id).map(|bet| bet.status_history)
    }
}
