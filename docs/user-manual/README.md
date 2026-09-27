# BCIS Subscription Billing and Collection System — User Manual

This manual is written for the five people who use the system every day. Each
section is that person's job, in order, with numbered steps. Steps that need a
screenshot say so, and are marked **[screenshot]** for the documentation pack.

The system runs on the office PCs. The API server (the "brain" of the system)
runs on PC-1 and all three PCs talk to it. You always log in with your own
username — never share an account.

> **Colours used below.** Green messages mean the action succeeded. Red messages
> mean it did not; read the message and try again.

---

## 1. Administrator

The Administrator sets the system up and is the only role that can manage users,
change business rules, reverse payments, adjust the ledger, or read the audit
trail. Do everything in this section once, at setup, and repeat steps 2–4 whenever
there is a change.

### 1.1 Start the system (once, on PC-1)

1. Make sure PostgreSQL is running on PC-1 (see the Deployment Guide).
2. Start the API server. On PC-1 open a terminal in the project folder and run:
   `pnpm start`.
3. Leave that window open. The API must stay running for the other PCs to work.
4. **[screenshot]** The server log should say the server is listening on
   `http://0.0.0.0:3003`.

### 1.2 First login

1. Open the BCIS app on your PC.
2. Enter the Administrator username and password from the Deployment Guide.
3. **[screenshot]** You should land on the Home screen with a green
   "API reachable" badge.

### 1.3 Change the Administrator password

1. Go to **Users**.
2. Find your own account and choose **Change password**.
3. Enter a new password of at least 12 characters and save.
4. Do this immediately after the first login — the bootstrap password is printed
   in the Deployment Guide and is not a secret.

### 1.4 Create the other users

1. Go to **Users** → **Add user**.
2. Enter the full name, a username, a temporary password, and the role:
   Billing Clerk, Cashier, Collector, or Manager.
3. Choose **Save**. The new user appears in the list.
4. Tell that person their temporary password; ask them to change it on first
   login.
5. To stop someone working, open their account and choose **Deactivate**. The
   account stays in the list and on old receipts, but cannot log in.
6. To change a role, open the account, choose the new role, and save.

### 1.5 Set the business rules

1. Go to **System Settings**.
2. Change any of: late fee (in centavos), invoice due day, suspension-after days,
   company name, address, phone, and receipt footer text.
3. Choose **Save**. Every change is written to the audit trail.

### 1.6 Review the audit trail

1. Go to **Audit Logs**.
2. Filter by action, entity, or user.
3. Each row shows who did what, to which record, when, and from which PC.

### 1.7 Correct a mistake

1. To undo a wrong payment: open the payment, choose **Reverse**, and give a
   reason (at least 10 characters). The original payment is kept and a reversal
   document `RV-…` is recorded beside it — money history is never deleted, and the
   money returns to the subscriber's balance.
2. A GCash payment that is still **Pending Verification** cannot be reversed — it
   never posted, so there is nothing to undo. Open the GCash verification queue and
   **Reject** it with a reason instead.
3. Reversing a **verified** GCash payment works exactly like reversing cash. The
   record still shows who verified the transfer, and the payment no longer counts as
   received.
4. To undo a wrong invoice: open the invoice and choose **Void** with a reason.
5. To adjust a balance by hand: open the service account's **Ledger** and choose
   **Manual entry**, giving a reason.
6. To check a ledger: open the service account's **Ledger** and choose
   **Verify integrity**. A green result means the running balance recomputed from
   the entries matches what is stored.

### 1.8 Back up the database

1. On PC-1, run `pnpm backup`. It writes a timestamped file into `backups/`.
2. Keep backups on a second drive or a USB stick as well.
3. To restore, follow `docs/deployment/backup-restore.md` exactly.

---

## 2. Billing Clerk

The Billing Clerk keeps subscriber records correct, runs the monthly billing, and
handles suspensions and reconnections.

### 2.1 Add a subscriber

1. Go to **Subscribers** → **Add subscriber**.
2. Fill in the name, primary phone, and service address (barangay, municipality,
   province are required).
3. Choose a **plan** for the first service account and an activation date.
4. Choose **Save**. The system generates the account number automatically.
5. **[screenshot]** The new subscriber's detail page opens, showing the service
   account with status **pending** or **active**.

### 2.2 Add another service for the same subscriber

1. Open the subscriber's detail page.
2. Choose **Add service account**, pick a plan, and choose an activation date.
3. Choose **Save**. A household can now have Internet and Cable TV billed
   separately.

### 2.3 Create or retire a plan

1. Go to **Plans** → **Add plan**.
2. Enter the name, service type, speed or package description, the monthly rate in
   centavos, and any reconnection fee.
3. Choose **Save**.
4. To stop new signups of an old plan, open it and choose **Retire**. Existing
   accounts keep the old plan and price. **To change a price, create a new plan**
   — never edit the old one.

### 2.4 Run the monthly billing

1. Go to **Billing**.
2. Pick the **year** and **month**.
3. Choose **Preview run**: the system shows how many accounts will be billed, how
   many already have an invoice, and the total.
4. Read the preview. If it looks right, choose **Run billing**. Draft invoices are
   created; accounts that already have an invoice for that month are skipped, so
   running it twice cannot double-bill.
5. Choose **Post all drafts** to make the invoices official. Posting writes the
   amounts into each account's ledger.
6. **[screenshot]** The billing run history at the bottom of the screen lists every
   run with its totals.

### 2.5 Charge a late fee

1. On the **Billing** screen, choose **Apply late fees**.
2. Leave the amount blank to use the fee in System Settings, or type a different
   amount in centavos.
3. Only overdue, unpaid invoices are charged.

### 2.6 Suspend and reconnect a service

1. Open the service account.
2. Choose **Suspend** and give a reason (for example "overdue 60 days"). The
   status becomes **suspended**; billing is paused but the balance is still owed.
3. To restore service, choose **Reconnect**. If the plan has a reconnection fee,
   the system raises a fee invoice and tells you the amount.
4. To end service permanently, choose **Terminate** and give a reason.

### 2.7 See who is overdue

1. Go to **Receivables** → **Overdue accounts**.
2. The screen groups accounts by how many months they are overdue and shows the
   amount owed and the assigned collector.
3. To cut off several accounts at once, tick them, choose **Suspend selected**, and
   give one reason.

---

## 3. Cashier

The Cashier takes money at the office counter and prints receipts.

### 3.1 Find the account

1. Go to **Payments** → **Post payment**.
2. Search by subscriber name, account number, or phone.
3. Choose the service account. The screen shows every unpaid invoice and any
   credit the account already holds.

### 3.2 Post a cash payment

1. Enter the amount received **in pesos** (the screen does the centavo maths).
2. Choose the payment date and method — **Cash**, **Bank Transfer**, **Cheque** or
   **Other**. All four post straight away.
3. Add a note if useful (for example "paid by family member").
4. Choose **Post payment**.
5. **[screenshot]** The receipt preview opens. The system allocated the money to
   the oldest invoice first and shows what is still outstanding.

> If you hold the **manual allocation** permission, you can instead send the payment
> to the invoices you name, giving a reason. Every centavo must be accounted for:
> anything you do not allocate is declared as the subscriber's advance credit. The
> reason and the invoices chosen are recorded in the audit trail.

### 3.3 Post a GCash payment

A GCash payment is **two steps**: you record the transfer, and someone with the
verification permission confirms it. The money does not reach the subscriber's
account until it is confirmed, because a screenshot on its own does not prove money
arrived.

1. Go to **Payments** → **Post payment** and find the account as in steps 1–2 above,
   then choose method **GCash**.
2. Type the GCash **reference number** as shown in the subscriber's screenshot, plus
   the sender name and number if known.
3. Optionally choose **Attach screenshot** and pick the image file.
4. Choose **Post payment**. The payment is saved as **Pending Verification**: no
   invoice is settled, no credit is given, and the receipt number is held for it.
   Tell the subscriber it will be applied once the transfer is confirmed.
5. **The same reference number can never be used twice.** Spaces and capitals do not
   help — `0031 234 567`, `0031234567` and `0031234567 ` are all treated as the same
   reference, and the system refuses the duplicate with a red message naming the
   reference. Check with the subscriber; if the earlier payment was rejected, ask a
   supervisor to look at it rather than re-entering the same reference.

#### Verify or reject a pending GCash payment

Anyone holding the GCash verification permission (the Cashier and the
Administrator) can do this.

1. Open the GCash verification queue (**Payments** → **GCash verification**). The
   oldest claim is first.
2. Open the claim and check the reference, sender and screenshot against the actual
   GCash transfer. When the office can see the transfer in the wallet:
   - choose **Verify** — the system now posts and allocates the payment exactly like
     cash (oldest unpaid invoice first) and prints the receipt; or
   - choose **Reject** and type **why** (at least 10 characters). The rejection is
     recorded with your name and the reason, and the subscriber's invoices are left
     exactly as they were.
3. A rejected claim can never be verified afterwards. If the subscriber sends the
   money again, record it under the **new** transfer's reference number.

> Never verify a claim you cannot see in the GCash wallet. Verifying is what moves
the money; the screenshot only records what somebody said.

### 3.4 Print a receipt

1. On the receipt preview, choose **Print**.
2. The Windows print dialog opens. Pick the printer and print.
3. To reprint later, open **Payment History**, find the payment, and open its
   receipt.

### 3.5 Handle an overpayment

1. If the amount is larger than everything owed, the receipt shows the extra as an
   **advance credit**.
2. The credit is applied automatically to the next monthly invoice. Do not create
   a manual invoice for it.

### 3.6 Look up a payment or the ledger

1. Go to **Payment History** to search by receipt number, account, method, or date.
2. Open a service account and choose **Ledger** to see every charge and payment in
   date order, or **Statement of Account** to print a summary for the subscriber.

### 3.7 Reconcile a collector's remittance

1. Go to **Collector Batches** and open a batch whose status is **submitted**.
2. Compare the cash handed in with the **expected** total.
3. If they differ, the variance is shown (a shortage or an overage).
4. Choose **Reconcile**, write what explains the difference, and confirm. Only an
   Administrator reverses a payment; ask them if a collection was recorded wrongly.

---

## 4. Collector

The Collector works the batches assigned to them in the field and remits the cash.

### 4.1 Open your batch

1. Go to **Collector Batches**. You see only your own batches.
2. Open the batch for today. It lists the assigned accounts and each balance.

### 4.2 Record what happened at each house

1. Open an assignment.
2. Choose the **result**: Collected, Partial, No response, Refused, or Promise.
3. If money was collected, enter the amount and choose **Cash** or **GCash**.
4. If the subscriber paid, the system creates the official payment and receipt
   immediately — no office entry is needed later.
5. Add a note if helpful (for example "will pay on Friday").
6. Choose **Save** and continue to the next account.

### 4.3 Correct a collection you recorded wrongly

1. Open the assignment and choose **Void**, giving a reason.
2. The payment created from it is reversed, and the assignment keeps its record.
3. Record the correct result.

### 4.4 Remit the cash

1. When you return to the office, open the batch and choose **Submit remittance**.
2. Type the total cash and GCash you are handing in.
3. Choose **Submit**. If it differs from what you collected, the system shows the
   difference and asks for a note — it is never hidden.

### 4.5 After the office reconciles

1. The Cashier reconciles the batch. Once reconciled, the batch is closed and no
   more collections can be recorded on it.
2. A shortage or overage stays visible on the batch forever.

---

## 5. Manager

The Manager reviews the business: it is read-only, and cannot create or change any
record.

### 5.1 Open the dashboard

1. Log in and open **Dashboard**.
2. **[screenshot]** The tiles show active, suspended, and terminated accounts;
   invoiced and collected totals for the month; the collection rate; total
   outstanding receivables; overdue over 30 and over 90 days; open collector
   batches; and the last billing run.

### 5.2 Open the reports centre

1. Go to **Reports**.
2. Choose one of the reports: Daily Collection, Monthly Billing Summary, AR Aging,
   Collector Remittance, Outstanding by Collector.
3. Set the date or period, then choose **Run**.

### 5.3 Export a report

1. With a report on screen, choose **Export PDF** to print or email a document, or
   **Export XLSX** to work with the numbers in a spreadsheet.
2. Choose where to save the file when the dialog appears.
3. **[screenshot]** The exported file matches the numbers on the screen.

### 5.4 Read the aged receivables

1. Open **Reports** → **AR Aging**.
2. The table groups each account's unpaid balance into Current, 1–30, 31–60,
   61–90, and over 90 days.
3. The totals row is the amount the whole business is owed — it always equals the
   sum of the outstanding invoice balances.

---

## 6. Every user: logging out and getting help

1. Choose **Log out** in the top corner. Your session token is cancelled on the
   server immediately, so it cannot be reused.
2. If the badge says **API offline**, the server PC is not running or the network
   is down. Ask the Administrator to check PC-1.
3. Sessions last one working day; you are asked to log in again the next morning.