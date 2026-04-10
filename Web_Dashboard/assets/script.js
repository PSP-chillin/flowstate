// ============== CONFIGURATION ==============
// ADD YOUR SUPABASE CREDENTIALS HERE
const SUPABASE_CONFIG = {
    url: '*******************', // Replace with your Supabase URL
    key: '***************************************************************************' // Replace with your Supabase Anon Key
};

const CONFIG = {
    normalThreshold: 5,
    warningThreshold: 15,
    costPerLiter: 0.05,
    chartPointsLimit: 60 // Last 60 data points
};



let supabaseClient = null;
let isConfigured = false;
let readingsSubscription = null;
let alertsSubscription = null;
let isDarkMode = false;

// Data storage
const dataStore = {
    readings: [],
    alerts: [],
    hourlyUsage: {}
};

// Chart instances
let flowChart = null;
let volumeChart = null;
let hourlyChart = null;
let lossChart = null;

// ============== INITIALIZATION ==============
document.addEventListener('DOMContentLoaded', function() {
    console.log('Dashboard initialized');
    loadTheme();
    setupThemeToggle();
    loadConfiguration();
    initSupabase(SUPABASE_CONFIG.url, SUPABASE_CONFIG.key);
    initializeCharts();
    startMonitoring();
});

// ============== THEME MANAGEMENT ==============
function loadTheme() {
    const savedTheme = localStorage.getItem('theme');
    isDarkMode = savedTheme === 'dark';
    applyTheme(isDarkMode);
}

function setupThemeToggle() {
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', toggleTheme);
    }
}

function toggleTheme() {
    isDarkMode = !isDarkMode;
    localStorage.setItem('theme', isDarkMode ? 'dark' : 'light');
    applyTheme(isDarkMode);
    updateThemeButtonDisplay();
}

function applyTheme(dark) {
    if (dark) {
        document.body.classList.add('dark-mode');
        document.documentElement.style.setProperty('--bg-color', '#0d1117');
        document.documentElement.style.setProperty('--text-color', '#e6edf3');
        document.documentElement.style.setProperty('--card-bg', 'rgba(13, 17, 23, 0.7)');
    } else {
        document.body.classList.remove('dark-mode');
        document.documentElement.style.setProperty('--bg-color', '#F0F4F8');
        document.documentElement.style.setProperty('--text-color', '#0D1B2A');
        document.documentElement.style.setProperty('--card-bg', 'rgba(255, 255, 255, 0.7)');
    }
    updateThemeButtonDisplay();
}

function updateThemeButtonDisplay() {
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
        themeToggle.textContent = isDarkMode ? '🌙 Dark' : '☀️ Light';
    }
}

// ============== CONFIGURATION MANAGEMENT ==============
// Credentials are set in SUPABASE_CONFIG at the top of this file
// To change credentials, edit the SUPABASE_CONFIG object above

function initSupabase(url, key) {
    try {
        supabaseClient = window.supabase.createClient(url, key);
        isConfigured = true;
        console.log('Supabase client initialized');
        console.log('URL:', url);
        updateSystemStatus(true);
        
        // Diagnostic: list all tables
        diagnoseSupabase();
    } catch (error) {
        console.error('Failed to initialize Supabase:', error);
        isConfigured = false;
        updateSystemStatus(false);
        showAlert('Failed to connect to Supabase', 'critical');
    }
}

async function diagnoseSupabase() {
    try {
        console.log('=== Supabase Diagnostic ===');
        
        // Try to fetch from water_readings
        const { data: wr, error: wr_error, status: wr_status } = await supabaseClient
            .from('water_readings')
            .select('count', { count: 'exact', head: true });
        
        if (wr_error) {
            console.error('❌ water_readings error:', wr_error.message, 'Code:', wr_error.code);
        } else {
            console.log('✓ water_readings table exists');
        }
        
        // Try to fetch from alerts
        const { data: alerts, error: alerts_error, status: alerts_status } = await supabaseClient
            .from('alerts')
            .select('count', { count: 'exact', head: true });
        
        if (alerts_error) {
            console.error('❌ alerts error:', alerts_error.message, 'Code:', alerts_error.code);
        } else {
            console.log('✓ alerts table exists');
        }
        
        // Try to fetch any data
        const { data: data_test, error: data_error } = await supabaseClient
            .from('water_readings')
            .select('*')
            .limit(1);
        
        if (data_error) {
            console.error('❌ Cannot read water_readings:', data_error.message);
        } else {
            console.log('✓ Can read water_readings, records found:', data_test?.length || 0);
            if (data_test && data_test.length > 0) {
                console.log('Sample record:', data_test[0]);
            }
        }
    } catch (error) {
        console.error('Diagnostic error:', error);
    }
}

function resetData() {
    if (confirm('Are you sure? This will clear all local data.')) {
        dataStore.readings = [];
        dataStore.alerts = [];
        dataStore.hourlyUsage = {};
        updateCharts();
        showAlert('All data cleared', 'normal');
    }
}

function saveConfiguration() {
    const url = document.getElementById('supabaseUrl')?.value || SUPABASE_CONFIG.url;
    const key = document.getElementById('supabaseKey')?.value || SUPABASE_CONFIG.key;
    const normalThreshold = parseFloat(document.getElementById('normalThreshold')?.value || CONFIG.normalThreshold);
    const warningThreshold = parseFloat(document.getElementById('warningThreshold')?.value || CONFIG.warningThreshold);

    // Save to localStorage
    localStorage.setItem('supabaseUrl', url);
    localStorage.setItem('supabaseKey', key);
    localStorage.setItem('normalThreshold', normalThreshold);
    localStorage.setItem('warningThreshold', warningThreshold);

    // Update CONFIG
    CONFIG.normalThreshold = normalThreshold;
    CONFIG.warningThreshold = warningThreshold;

    // Reinitialize Supabase if credentials changed
    initSupabase(url, key);
    
    showAlert('Configuration saved successfully', 'normal');
    console.log('Configuration saved');
}

function loadConfiguration() {
    const savedUrl = localStorage.getItem('supabaseUrl');
    const savedKey = localStorage.getItem('supabaseKey');
    const savedNormalThreshold = localStorage.getItem('normalThreshold');
    const savedWarningThreshold = localStorage.getItem('warningThreshold');

    if (savedUrl) document.getElementById('supabaseUrl').value = savedUrl;
    if (savedKey) document.getElementById('supabaseKey').value = savedKey;
    if (savedNormalThreshold) document.getElementById('normalThreshold').value = savedNormalThreshold;
    if (savedWarningThreshold) document.getElementById('warningThreshold').value = savedWarningThreshold;
}



// ============== MONITORING ==============
function startMonitoring() {
    // Initial fetch
    fetchLatestData();
    // Subscribe to realtime updates
    subscribeToRealtimeUpdates();
}

function subscribeToRealtimeUpdates() {
    if (!isConfigured || !supabaseClient) {
        setTimeout(subscribeToRealtimeUpdates, 5000); // Retry in 5 seconds
        return;
    }

    try {
        // Subscribe to water_readings changes using new Supabase v2+ API
        readingsSubscription = supabaseClient
            .channel('public:water_readings')
            .on('postgres_changes', 
                { event: '*', schema: 'public', table: 'water_readings' },
                payload => {
                    console.log('Realtime reading update:', payload);
                    fetchLatestData();
                }
            )
            .subscribe();

        // Subscribe to alerts changes using new Supabase v2+ API
        alertsSubscription = supabaseClient
            .channel('public:alerts')
            .on('postgres_changes',
                { event: '*', schema: 'public', table: 'alerts' },
                payload => {
                    console.log('Realtime alert update:', payload);
                    fetchLatestData();
                }
            )
            .subscribe();

        console.log('Realtime subscriptions established');
    } catch (error) {
        console.error('Error setting up realtime subscriptions:', error);
        // Fallback to polling if realtime fails
        setInterval(fetchLatestData, 5000);
    }
}

async function fetchLatestData() {
    if (!isConfigured || !supabaseClient) {
        console.warn('Supabase not configured or client missing');
        updateSystemStatus(false);
        return;
    }

    try {
        console.log('Fetching latest data from Supabase...');
        
        // Fetch latest reading
        const { data: readings, error: readingsError } = await supabaseClient
            .from('water_readings')
            .select('*')
            .order('timestamp', { ascending: false })
            .limit(60);

        if (readingsError) {
            console.error('Error fetching readings:', readingsError);
            throw readingsError;
        }

        console.log('Readings fetched:', readings?.length || 0, 'records');
        if (readings && readings.length > 0) {
            dataStore.readings = readings.reverse(); // Chronological order
            updateSystemStatus(true);
            console.log('Latest reading:', readings[readings.length - 1]);
            updateDashboard(readings[readings.length - 1]); // Latest reading
        } else {
            console.warn('No readings found in water_readings table');
        }

        // Fetch recent alerts
        const { data: alerts, error: alertsError } = await supabaseClient
            .from('alerts')
            .select('*')
            .order('timestamp', { ascending: false })
            .limit(10);

        if (alertsError) {
            console.warn('Alerts fetch error:', alertsError.message);
            // Don't throw - alerts table is optional
        } else {
            console.log('Alerts fetched:', alerts?.length || 0, 'records');
            if (alerts && alerts.length > 0) {
                console.log('First alert:', alerts[0]);
                dataStore.alerts = alerts.reverse(); // Reverse for chronological order
                updateAlerts(dataStore.alerts);
            } else {
                console.warn('No alerts in table');
                updateAlerts([]);
            }
        }

        // Update charts with all readings
        updateCharts();
        updateLastUpdate();
        updateExportStats(); // Update export stats after data is fetched

    } catch (error) {
        console.error('Error fetching data:', error);
        updateSystemStatus(false);
    }
}

// ============== DASHBOARD UPDATES ==============
function updateDashboard(latestReading) {
    // Update tank level
    const waterLevel = latestReading.water_level || 0;
    updateTankLevel(waterLevel);

    // Update flow rates
    document.getElementById('flow1').textContent = (latestReading.flow_rate_1 || 0).toFixed(2) + ' L/min';
    document.getElementById('flow2').textContent = (latestReading.flow_rate_2 || 0).toFixed(2) + ' L/min';

    // Update progress bars
    const maxFlow = Math.max(latestReading.flow_rate_1 || 0, latestReading.flow_rate_2 || 0, 5);
    document.getElementById('progressFlow1').style.width = ((latestReading.flow_rate_1 || 0) / maxFlow * 100) + '%';
    document.getElementById('progressFlow2').style.width = ((latestReading.flow_rate_2 || 0) / maxFlow * 100) + '%';

    // Update leak detection
    const percentageLoss = latestReading.percentage_loss || 0;
    updateLeakDetection(percentageLoss, latestReading.leak_status);

    // Update system controls
    const valveState = latestReading.valve_state === 1 ? 'OPEN' : 'CLOSED';
    
    const valveIndicator = document.getElementById('valveIndicator');
    valveIndicator.classList.toggle('active', latestReading.valve_state === 1);
    document.getElementById('valveState').textContent = valveState;

    // Update anomaly status
    const anomalyStatusElement = document.getElementById('anomalyStatus');
    if (anomalyStatusElement) {
        anomalyStatusElement.textContent = latestReading.anomaly_status || 'Learning';
    }

    // Update statistics
    const dailyTotal = (latestReading.daily_total_liters || 0).toFixed(2);
    document.getElementById('dailyTotal').textContent = dailyTotal + ' L';

    // Calculate estimated loss
    const volume1 = latestReading.flow_rate_1 || 0;
    const volume2 = latestReading.flow_rate_2 || 0;
    const estimatedLoss = (volume1 - volume2).toFixed(2);
    const minimumLoss = Math.max(0, estimatedLoss);
    document.getElementById('estimatedLoss').textContent = minimumLoss + ' L';

    // Calculate cost
    const cost = (dailyTotal * CONFIG.costPerLiter).toFixed(2);
    document.getElementById('estimatedCost').textContent = '$' + cost;

    // Update export stats
    updateExportStats();
}

function updateTankLevel(waterLevel) {
    const maxLevel = 100;
    // Invert level: 100 - waterLevel (so full tank = highest value)
    const displayLevel = maxLevel - waterLevel;
    const percentage = Math.min(100, Math.max(0, (displayLevel / maxLevel) * 100));
    
    // Update liquid level: top position controls water height
    const liquid = document.querySelector('.water-tank .liquid');
    const label = document.getElementById('tankLabel');
    
    if (liquid) {
        liquid.style.top = `calc(100% - ${percentage}%)`;
    }
    
    // Update label with percentage
    if (label) {
        label.textContent = percentage.toFixed(0) + '%';
        label.style.bottom = percentage + '%';
    }
    
    // Update text display (show inverted level: 100 - waterLevel)
    document.getElementById('tankLevel').textContent = displayLevel.toFixed(1) + ' cm';
}

function updateLeakDetection(percentageLoss, leakStatus) {
    // Cap percentage at 100% max (prevent display issues with malformed data)
    const validPercentage = Math.min(100, Math.max(0, percentageLoss));
    
    // Debug: log if percentage is suspiciously high
    if (percentageLoss > 100) {
        console.warn('Unusual percentage detected:', percentageLoss, 'capped to', validPercentage);
    }
    
    document.getElementById('lossPercentage').textContent = validPercentage.toFixed(1);

    // Update circle progress
    const progress = document.getElementById('circleProgress');
    const maxPercentage = 30;
    const dashOffset = 345 * (1 - Math.min(validPercentage, maxPercentage) / maxPercentage);
    progress.style.strokeDashoffset = dashOffset;

    // Update color based on status
    progress.classList.remove('warning', 'critical');
    
    const badgeElement = document.getElementById('leakStatus');
    badgeElement.classList.remove('normal', 'warning', 'critical');

    if (leakStatus === 'Critical') {
        progress.classList.add('critical');
        badgeElement.classList.add('critical');
        badgeElement.textContent = 'CRITICAL ⚠️';
    } else if (leakStatus === 'Warning') {
        progress.classList.add('warning');
        badgeElement.classList.add('warning');
        badgeElement.textContent = 'WARNING ⚡';
    } else {
        badgeElement.classList.add('normal');
        badgeElement.textContent = 'NORMAL ✓';
    }
}

function updateAlerts(alerts) {
    const container = document.getElementById('alertsContainer');
    
    if (!container) {
        console.warn('Alert container not found');
        return;
    }
    
    console.log('Updating alerts display with', alerts.length, 'alerts');
    
    if (!alerts || alerts.length === 0) {
        container.innerHTML = '<div class="alert-item" style="color: #666;">No alerts yet</div>';
        return;
    }

    container.innerHTML = '';
    alerts.slice(0, 5).forEach(alert => {
        const alertDiv = document.createElement('div');
        
        // Determine severity class
        const severityClass = (alert.severity === 'critical' || alert.severity === 'high') ? 'critical' : 'warning';
        alertDiv.className = `alert-item ${severityClass}`;
        
        const timestamp = new Date(alert.timestamp).toLocaleString();
        alertDiv.innerHTML = `
            <strong>${alert.alert_type || 'Alert'}</strong>
            <div>${alert.message}</div>
            <div class="alert-timestamp">${timestamp}</div>
        `;
        container.appendChild(alertDiv);
    });
}

function updateSystemStatus(online) {
    const badge = document.getElementById('systemStatus');
    if (!badge) return; // Element doesn't exist, skip update
    
    const dot = badge.querySelector('.status-dot');
    
    if (online) {
        if (dot) dot.classList.remove('offline');
        if (dot) dot.classList.add('online');
        badge.innerHTML = '<span class="status-dot online"></span>Online';
    } else {
        if (dot) dot.classList.remove('online');
        if (dot) dot.classList.add('offline');
        badge.innerHTML = '<span class="status-dot offline"></span>Offline';
    }
}

function updateLastUpdate() {
    const now = new Date();
    document.getElementById('lastUpdate').textContent = 'Last Update: ' + now.toLocaleTimeString();
}

// ============== CONTROL FUNCTIONS ==============
function openValve() {
    console.log('Opening valve');
    const valveIndicator = document.getElementById('valveIndicator');
    const valveState = document.getElementById('valveState');
    
    // Update UI
    if (valveIndicator) {
        valveIndicator.classList.add('active');
        valveIndicator.style.color = '#4CAF50';
    }
    if (valveState) {
        valveState.textContent = 'OPEN';
    }
    
    showAlert('Valve opened', 'normal');
}

function closeValve() {
    console.log('Closing valve');
    const valveIndicator = document.getElementById('valveIndicator');
    const valveState = document.getElementById('valveState');
    
    // Update UI
    if (valveIndicator) {
        valveIndicator.classList.remove('active');
        valveIndicator.style.color = '#f44336';
    }
    if (valveState) {
        valveState.textContent = 'CLOSED';
    }
    
    showAlert('Valve closed', 'normal');
}



// ============== CHARTS ==============
function initializeCharts() {
    const chartOptions = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: {
                display: true,
                position: 'top'
            }
        },
        scales: {
            y: {
                beginAtZero: true
            }
        }
    };

    // Flow Rate Chart
    const flowCtx = document.getElementById('flowChart');
    if (flowCtx) {
        flowChart = new Chart(flowCtx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    {
                        label: 'Flow Rate 1 (L/min)',
                        data: [],
                        borderColor: '#2196F3',
                        backgroundColor: 'rgba(33, 150, 243, 0.1)',
                        tension: 0.3,
                        fill: true
                    },
                    {
                        label: 'Flow Rate 2 (L/min)',
                        data: [],
                        borderColor: '#4CAF50',
                        backgroundColor: 'rgba(76, 175, 80, 0.1)',
                        tension: 0.3,
                        fill: true
                    }
                ]
            },
            options: chartOptions
        });
    }

    // Volume Chart
    const volumeCtx = document.getElementById('volumeChart');
    if (volumeCtx) {
        volumeChart = new Chart(volumeCtx, {
            type: 'bar',
            data: {
                labels: [],
                datasets: [
                    {
                        label: 'Volume 1 (L)',
                        data: [],
                        backgroundColor: '#2196F3'
                    },
                    {
                        label: 'Volume 2 (L)',
                        data: [],
                        backgroundColor: '#4CAF50'
                    }
                ]
            },
            options: chartOptions
        });
    }

    // Hourly Usage Chart
    const hourlyCtx = document.getElementById('hourlyChart');
    if (hourlyCtx) {
        hourlyChart = new Chart(hourlyCtx, {
            type: 'bar',
            data: {
                labels: Array.from({length: 24}, (_, i) => i + ':00'),
                datasets: [
                    {
                        label: 'Hourly Usage (L)',
                        data: Array(24).fill(0),
                        backgroundColor: '#FF9800'
                    }
                ]
            },
            options: chartOptions
        });
    }

    // Loss Percentage Chart
    const lossCtx = document.getElementById('lossChart');
    if (lossCtx) {
        lossChart = new Chart(lossCtx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    {
                        label: 'Loss %',
                        data: [],
                        borderColor: '#F44336',
                        backgroundColor: 'rgba(244, 67, 54, 0.1)',
                        tension: 0.3,
                        fill: true
                    }
                ]
            },
            options: chartOptions
        });
    }
}

function updateCharts() {
    if (dataStore.readings.length === 0) return;

    const recentReadings = dataStore.readings.slice(-CONFIG.chartPointsLimit);

    // Update Flow Chart
    if (flowChart) {
        flowChart.data.labels = recentReadings.map((r, i) => {
            const date = new Date(r.timestamp);
            return date.toLocaleTimeString();
        });
        flowChart.data.datasets[0].data = recentReadings.map(r => r.flow_rate_1 || 0);
        flowChart.data.datasets[1].data = recentReadings.map(r => r.flow_rate_2 || 0);
        flowChart.update();
    }

    // Update Volume Chart (accumulated)
    if (volumeChart) {
        volumeChart.data.labels = recentReadings.map((r, i) => {
            const date = new Date(r.timestamp);
            return date.toLocaleTimeString();
        });
        volumeChart.data.datasets[0].data = recentReadings.map((r, i) => {
            return (r.flow_rate_1 || 0) * 0.1; // Approximate volume
        });
        volumeChart.data.datasets[1].data = recentReadings.map((r, i) => {
            return (r.flow_rate_2 || 0) * 0.1;
        });
        volumeChart.update();
    }

    // Update Loss Percentage Chart
    if (lossChart) {
        lossChart.data.labels = recentReadings.map((r, i) => {
            const date = new Date(r.timestamp);
            return date.toLocaleTimeString();
        });
        lossChart.data.datasets[0].data = recentReadings.map(r => r.percentage_loss || 0);
        lossChart.update();
    }

    // Update Hourly Chart (aggregate by hour)
    if (hourlyChart) {
        const hourlyData = Array(24).fill(0);
        const hourlyCount = Array(24).fill(0);

        recentReadings.forEach(r => {
            const date = new Date(r.timestamp);
            const hour = date.getHours();
            hourlyData[hour] += (r.flow_rate_1 || 0) * 0.1;
            hourlyCount[hour]++;
        });

        // Average by hour
        for (let i = 0; i < 24; i++) {
            if (hourlyCount[i] > 0) {
                hourlyData[i] = hourlyData[i] / hourlyCount[i];
            }
        }

        hourlyChart.data.datasets[0].data = hourlyData;
        hourlyChart.update();
    }
}

// ============== UTILITY FUNCTIONS ==============
function showAlert(message, type = 'normal') {
    console.log(`[${type.toUpperCase()}] ${message}`);
    // You can enhance this with a toast notification library
}

// ============== EXPORT & DOWNLOAD ==============
function exportData(format = 'json') {
    if (!dataStore.readings || dataStore.readings.length === 0) {
        showAlert('No data to export', 'warning');
        return;
    }

    let content, filename, type;

    if (format === 'csv') {
        content = convertToCSV(dataStore.readings);
        filename = `water_monitoring_${new Date().toISOString().split('T')[0]}.csv`;
        type = 'text/csv';
    } else if (format === 'json') {
        content = JSON.stringify(dataStore, null, 2);
        filename = `water_monitoring_${new Date().toISOString().split('T')[0]}.json`;
        type = 'application/json';
    }

    const dataBlob = new Blob([content], { type: type });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    showAlert(`Data exported as ${format.toUpperCase()} successfully`, 'normal');
}

function convertToCSV(readings) {
    if (!readings || readings.length === 0) return '';

    const headers = Object.keys(readings[0]);
    const csv = [headers.join(',')];

    readings.forEach(row => {
        const values = headers.map(header => {
            const value = row[header];
            // Escape values containing commas or quotes
            if (typeof value === 'string' && (value.includes(',') || value.includes('"'))) {
                return `"${value.replace(/"/g, '""')}"`;
            }
            return value;
        });
        csv.push(values.join(','));
    });

    return csv.join('\n');
}

function updateExportStats() {
    const recordCount = dataStore.readings ? dataStore.readings.length : 0;
    const alertCount = dataStore.alerts ? dataStore.alerts.length : 0;
    
    console.log('updateExportStats() - Records:', recordCount, 'Alerts:', alertCount, 'dataStore.alerts:', dataStore.alerts);
    
    const recordElement = document.getElementById('exportRecordCount');
    const alertElement = document.getElementById('exportAlertCount');
    
    if (recordElement) {
        recordElement.textContent = recordCount;
    }
    if (alertElement) {
        alertElement.textContent = alertCount;
    }
}

// ============== RESPONSIVE UPDATES ==============
window.addEventListener('resize', function() {
    if (flowChart) flowChart.resize();
    if (volumeChart) volumeChart.resize();
    if (hourlyChart) hourlyChart.resize();
    if (lossChart) lossChart.resize();
});

// ============== KEYBOARD SHORTCUTS ==============
document.addEventListener('keydown', function(event) {
    if (event.ctrlKey && event.key === 's') {
        event.preventDefault();
        saveConfiguration();
    }
    if (event.key === 'r' && event.ctrlKey) {
        event.preventDefault();
        location.reload();
    }
});

console.log('Script loaded successfully');
